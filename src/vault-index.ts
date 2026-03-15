import { readdir, stat, watch } from "node:fs/promises";
import { watch as fsWatch, type FSWatcher } from "node:fs";
import path from "node:path";

export interface FileEntry {
  /** Absolute path */
  abs: string;
  /** Path relative to vault root */
  rel: string;
  /** Filename without extension */
  stem: string;
  /** File extension (with dot) */
  ext: string;
  /** Parent directory relative to vault */
  dir: string;
  /** Created timestamp (ms) */
  ctime: number;
  /** Last modified timestamp (ms) */
  mtime: number;
  /** File size in bytes */
  size: number;
}

export class VaultIndex {
  /** rel path → FileEntry */
  private files = new Map<string, FileEntry>();
  /** stem (lowercase) → rel paths (for fast name lookup) */
  private byName = new Map<string, Set<string>>();
  /** directory rel path → child rel paths */
  private byDir = new Map<string, Set<string>>();
  /** fs watchers */
  private watchers: FSWatcher[] = [];

  private ready = false;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;

  constructor(
    public readonly vaultPath: string,
    private readonly ignoreDirs = new Set([".obsidian", ".git", ".trash", "node_modules", ".DS_Store"]),
  ) {
    this.readyPromise = new Promise((r) => (this.resolveReady = r));
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  async init(): Promise<void> {
    const start = Date.now();
    await this.scanDir("");
    this.ready = true;
    this.resolveReady();
    this.startWatching();
    const elapsed = Date.now() - start;
    console.error(
      `[vault-index] Indexed ${this.files.size} files in ${elapsed}ms`,
    );
  }

  async waitReady(): Promise<void> {
    return this.readyPromise;
  }

  destroy(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  // ── Queries ────────────────────────────────────────────────────────

  get(relPath: string): FileEntry | undefined {
    return this.files.get(this.normalizePath(relPath));
  }

  has(relPath: string): boolean {
    return this.files.has(this.normalizePath(relPath));
  }

  /** Find files by stem (filename without ext), case-insensitive */
  findByName(name: string): FileEntry[] {
    const key = name.toLowerCase().replace(/\.\w+$/, "");
    const rels = this.byName.get(key);
    if (!rels) return [];
    return [...rels].map((r) => this.files.get(r)!).filter(Boolean);
  }

  /** List files in a directory (non-recursive) */
  listDir(relDir: string): FileEntry[] {
    const norm = this.normalizePath(relDir) || ".";
    const children = this.byDir.get(norm);
    if (!children) return [];
    return [...children].map((r) => this.files.get(r)!).filter(Boolean);
  }

  /** Glob-like search: supports * and ** in patterns */
  glob(pattern: string): FileEntry[] {
    const regex = this.globToRegex(pattern);
    const results: FileEntry[] = [];
    for (const [rel, entry] of this.files) {
      if (regex.test(rel)) results.push(entry);
    }
    return results;
  }

  /** Full-text search in paths (fast, no content scan) */
  searchPaths(query: string): FileEntry[] {
    const lower = query.toLowerCase();
    const results: FileEntry[] = [];
    for (const [rel, entry] of this.files) {
      if (rel.toLowerCase().includes(lower)) results.push(entry);
    }
    return results;
  }

  /** Get all files sorted by mtime (most recent first) */
  recentFiles(limit = 20): FileEntry[] {
    return [...this.files.values()]
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
  }

  /** Get all indexed file entries */
  allFiles(): FileEntry[] {
    return [...this.files.values()];
  }

  /** Get vault stats */
  stats(): { totalFiles: number; totalDirs: number; extensions: Record<string, number> } {
    const extensions: Record<string, number> = {};
    for (const entry of this.files.values()) {
      const ext = entry.ext || "(none)";
      extensions[ext] = (extensions[ext] || 0) + 1;
    }
    return {
      totalFiles: this.files.size,
      totalDirs: this.byDir.size,
      extensions,
    };
  }

  // ── Resolve path (fuzzy) ───────────────────────────────────────────

  /**
   * Resolve a possibly partial path to a full relative path.
   * Tries: exact match → with .md extension → stem search → path search
   */
  resolve(input: string): FileEntry | undefined {
    const norm = this.normalizePath(input);

    // Exact match
    if (this.files.has(norm)) return this.files.get(norm);

    // Try adding .md
    const withMd = norm.endsWith(".md") ? norm : norm + ".md";
    if (this.files.has(withMd)) return this.files.get(withMd);

    // Stem search (return first match)
    const byName = this.findByName(path.basename(norm));
    if (byName.length === 1) return byName[0];

    // Path substring (return first match)
    const byPath = this.searchPaths(norm);
    if (byPath.length === 1) return byPath[0];

    return undefined;
  }

  // ── Internal: Scanning ─────────────────────────────────────────────

  private async scanDir(relDir: string): Promise<void> {
    const absDir = path.join(this.vaultPath, relDir);
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (this.ignoreDirs.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;

      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        // Register directory
        if (!this.byDir.has(relPath)) this.byDir.set(relPath, new Set());
        await this.scanDir(relPath);
      } else if (entry.isFile()) {
        await this.addFile(relPath);
      }
    }
  }

  private async addFile(relPath: string): Promise<FileEntry | undefined> {
    const absPath = path.join(this.vaultPath, relPath);
    let st;
    try {
      st = await stat(absPath);
    } catch {
      return undefined;
    }

    const parsed = path.parse(relPath);
    const dir = parsed.dir || ".";
    const stem = parsed.name;

    const entry: FileEntry = {
      abs: absPath,
      rel: relPath,
      stem,
      ext: parsed.ext,
      dir,
      ctime: st.birthtimeMs,
      mtime: st.mtimeMs,
      size: st.size,
    };

    this.files.set(relPath, entry);

    // Index by name
    const nameKey = stem.toLowerCase();
    if (!this.byName.has(nameKey)) this.byName.set(nameKey, new Set());
    this.byName.get(nameKey)!.add(relPath);

    // Index by directory
    if (!this.byDir.has(dir)) this.byDir.set(dir, new Set());
    this.byDir.get(dir)!.add(relPath);

    return entry;
  }

  private removeFile(relPath: string): void {
    const entry = this.files.get(relPath);
    if (!entry) return;

    this.files.delete(relPath);

    // Remove from name index
    const nameKey = entry.stem.toLowerCase();
    this.byName.get(nameKey)?.delete(relPath);
    if (this.byName.get(nameKey)?.size === 0) this.byName.delete(nameKey);

    // Remove from dir index
    this.byDir.get(entry.dir)?.delete(relPath);
  }

  // ── Internal: Watching ─────────────────────────────────────────────

  private startWatching(): void {
    try {
      const watcher = fsWatch(
        this.vaultPath,
        { recursive: true, persistent: false },
        (eventType, filename) => {
          if (!filename) return;
          const normalized = filename.replace(/\\/g, "/");

          // Skip ignored dirs
          const firstSegment = normalized.split("/")[0];
          if (this.ignoreDirs.has(firstSegment)) return;
          if (firstSegment.startsWith(".")) return;

          // Debounce via setImmediate to batch rapid changes
          setImmediate(() => this.handleChange(normalized));
        },
      );
      this.watchers.push(watcher);
    } catch (err) {
      console.error("[vault-index] fs.watch failed, index will be static:", err);
    }
  }

  private async handleChange(relPath: string): Promise<void> {
    const absPath = path.join(this.vaultPath, relPath);
    try {
      const st = await stat(absPath);
      if (st.isFile()) {
        // Upsert
        this.removeFile(relPath);
        await this.addFile(relPath);
      } else if (st.isDirectory()) {
        // New directory - scan it
        if (!this.byDir.has(relPath)) {
          this.byDir.set(relPath, new Set());
          await this.scanDir(relPath);
        }
      }
    } catch {
      // File was deleted
      this.removeFile(relPath);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private normalizePath(p: string): string {
    return p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  }

  private globToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "{{DOUBLESTAR}}")
      .replace(/\*/g, "[^/]*")
      .replace(/{{DOUBLESTAR}}/g, ".*");
    return new RegExp(`^${escaped}$`, "i");
  }
}
