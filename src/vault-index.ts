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

export interface DirEntry {
  /** Path relative to vault root */
  rel: string;
  /** Absolute path */
  abs: string;
  /** Number of direct children (files + subdirectories) */
  children_count: number;
  /** Created timestamp (ms) */
  ctime: number;
  /** Last modified timestamp (ms) */
  mtime: number;
}

export interface SerializedIndex {
  files: [string, FileEntry][];
  byName: [string, string[]][];
  byDir: [string, string[]][];
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

  /** List subdirectories of a directory (non-recursive) */
  async listDirEntries(relDir: string): Promise<DirEntry[]> {
    const norm = this.normalizePath(relDir) || ".";
    const prefix = norm === "." ? "" : norm + "/";
    const resultMap = new Map<string, DirEntry>();

    for (const dirKey of this.byDir.keys()) {
      // Direct child: starts with prefix and has no further slashes
      if (prefix === "") {
        if (dirKey.includes("/")) continue; // not a direct child of root
      } else {
        if (!dirKey.startsWith(prefix)) continue;
        const rest = dirKey.slice(prefix.length);
        if (rest.includes("/")) continue; // not a direct child
      }
      if (dirKey === norm) continue; // skip self

      // Verify directory actually exists on disk (skip ghosts)
      const absPath = path.join(this.vaultPath, dirKey);
      const dirStat = await stat(absPath).catch(() => null);
      if (!dirStat) continue;

      const fileChildren = this.byDir.get(dirKey)?.size ?? 0;
      // Count sub-subdirectories
      const subDirPrefix = dirKey + "/";
      let subDirs = 0;
      for (const k of this.byDir.keys()) {
        if (k.startsWith(subDirPrefix) && !k.slice(subDirPrefix.length).includes("/")) {
          subDirs++;
        }
      }

      let ctime = 0;
      let mtime = 0;
      let childrenCount = fileChildren + subDirs;

      // Use the earliest ctime and latest mtime from direct file children
      const children = this.byDir.get(dirKey);
      if (children) {
        for (const childRel of children) {
          const entry = this.files.get(childRel);
          if (entry) {
            if (ctime === 0 || entry.ctime < ctime) ctime = entry.ctime;
            if (entry.mtime > mtime) mtime = entry.mtime;
          }
        }
      }

      // For dirs with no indexed children, fall back to filesystem data
      // (handles dirs that only contain excluded content like .obsidian/)
      if (childrenCount === 0) {
        const diskChildren = await readdir(absPath).catch(() => []);
        childrenCount = diskChildren.length;
        ctime = dirStat.birthtimeMs;
        mtime = dirStat.mtimeMs;
      }

      // Dirs whose direct children are all subdirs (no files) still have ctime/mtime 0
      if (!ctime) ctime = dirStat.birthtimeMs;
      if (!mtime) mtime = dirStat.mtimeMs;

      resultMap.set(dirKey, {
        rel: dirKey,
        abs: absPath,
        children_count: childrenCount,
        ctime,
        mtime,
      });
    }

    // Supplement with filesystem scan for directories not in the index
    const targetAbs = norm === "." ? this.vaultPath : path.join(this.vaultPath, norm);
    const fsEntries = await readdir(targetAbs, { withFileTypes: true }).catch(() => []);
    for (const entry of fsEntries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue; // skip dotfiles/dotdirs
      const childRel = prefix ? prefix + entry.name : entry.name;
      if (resultMap.has(childRel)) continue; // already from index

      // This dir exists on disk but not in index — include it
      const childAbs = path.join(targetAbs, entry.name);
      const st = await stat(childAbs).catch(() => null);
      if (!st) continue;
      const diskChildren = await readdir(childAbs).catch(() => []);
      resultMap.set(childRel, {
        rel: childRel,
        abs: childAbs,
        children_count: diskChildren.length,
        ctime: st.birthtimeMs,
        mtime: st.mtimeMs,
      });
    }

    return [...resultMap.values()];
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

  /** Check if a directory exists in the index */
  hasDir(relDir: string): boolean {
    const norm = this.normalizePath(relDir) || ".";
    return this.byDir.has(norm);
  }

  /** Check if a directory is empty (no files and no subdirectories) */
  isDirEmpty(relDir: string): boolean {
    const norm = this.normalizePath(relDir) || ".";
    const children = this.byDir.get(norm);
    if (!children || children.size > 0) return children ? children.size === 0 : true;
    // Also check for subdirectories
    const prefix = norm === "." ? "" : norm + "/";
    for (const dirKey of this.byDir.keys()) {
      if (dirKey === norm) continue;
      if (prefix === "" ? !dirKey.includes("/") : dirKey.startsWith(prefix)) {
        return false;
      }
    }
    return true;
  }

  /** Count children (files + direct subdirectories) of a directory */
  countChildren(relDir: string): number {
    const norm = this.normalizePath(relDir) || ".";
    const fileChildren = this.byDir.get(norm)?.size ?? 0;
    const prefix = norm === "." ? "" : norm + "/";
    let subDirs = 0;
    for (const k of this.byDir.keys()) {
      if (k === norm) continue;
      if (prefix === "") {
        if (!k.includes("/")) subDirs++;
      } else {
        if (k.startsWith(prefix) && !k.slice(prefix.length).includes("/")) subDirs++;
      }
    }
    return fileChildren + subDirs;
  }

  /** Remove a directory and all its children from the index */
  removeDir(relDir: string): { filesRemoved: number; dirsRemoved: number } {
    const norm = this.normalizePath(relDir) || ".";
    const prefix = norm + "/";
    let filesRemoved = 0;
    let dirsRemoved = 0;

    // Remove all files under this directory (recursively)
    for (const [rel] of [...this.files]) {
      if (rel.startsWith(prefix) || this.files.get(rel)?.dir === norm) {
        this.removeFile(rel);
        filesRemoved++;
      }
    }

    // Remove all subdirectories
    for (const dirKey of [...this.byDir.keys()]) {
      if (dirKey.startsWith(prefix)) {
        this.byDir.delete(dirKey);
        dirsRemoved++;
      }
    }

    // Remove the directory itself
    if (this.byDir.has(norm)) {
      this.byDir.delete(norm);
      dirsRemoved++;
    }

    return { filesRemoved, dirsRemoved };
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

  /** Serialize index to a plain object */
  serialize(): SerializedIndex {
    return {
      files: [...this.files.entries()],
      byName: [...this.byName.entries()].map(([k, v]) => [k, [...v]]),
      byDir: [...this.byDir.entries()].map(([k, v]) => [k, [...v]]),
    };
  }

  /** Deserialize from a plain object */
  deserialize(data: SerializedIndex): void {
    this.files = new Map(data.files);
    this.byName = new Map(data.byName.map(([k, v]) => [k, new Set(v)]));
    this.byDir = new Map(data.byDir.map(([k, v]) => [k, new Set(v)]));
    this.ready = true;
    this.resolveReady();
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
      watcher.on("error", () => {
        // Silently ignore — watcher errors (ENOENT on deleted dirs) are expected
      });
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
