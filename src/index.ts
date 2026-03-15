#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, writeFile, mkdir, unlink, appendFile, rm, rename } from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import { VaultIndex } from "./vault-index.js";
import { registerCanvasCreate } from "./tools/canvas/canvas-create.js";
import { registerCanvasRead } from "./tools/canvas/canvas-read.js";
import { registerCanvasPatch } from "./tools/canvas/canvas-patch.js";
import { registerCanvasRelayout } from "./tools/canvas/canvas-relayout.js";
import { registerSmartSearch } from "./tools/search/smart-search.js";
import { registerSearchReindex } from "./tools/search/search-reindex.js";
import { registerVaultThemes } from "./tools/intelligence/vault-themes.js";
import { registerVaultSuggest } from "./tools/intelligence/vault-suggest.js";
import { registerEditRegex } from "./tools/notes/edit-regex.js";
import { registerBatchRename } from "./tools/files/batch-rename.js";
import { registerUpdateLinks, updateWikilinks } from "./tools/links/update-links.js";
import { registerBacklinks } from "./tools/links/backlinks.js";
import { registerFrontmatter, parseFrontmatter, serializeFrontmatter } from "./tools/metadata/frontmatter.js";

// ── Config ─────────────────────────────────────────────────────────

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH;
if (!VAULT_PATH) {
  console.error("ERROR: Set OBSIDIAN_VAULT_PATH environment variable");
  process.exit(1);
}

const vault = new VaultIndex(VAULT_PATH);
const server = new McpServer({
  name: "obsidian-forge-mcp",
  version: "0.2.0",
});

// ── Helpers ─────────────────────────────────────────────────────────

function abs(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return path.join(VAULT_PATH!, normalized);
}

function ensureMd(relPath: string): string {
  if (!path.extname(relPath)) return relPath + ".md";
  return relPath;
}

async function ensureDir(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
}

function resolveOrFail(input: string): { abs: string; rel: string } {
  const entry = vault.resolve(input);
  if (entry) return { abs: entry.abs, rel: entry.rel };
  // If not indexed yet, treat as literal path
  const rel = ensureMd(input.replace(/\\/g, "/").replace(/^\/+/, ""));
  return { abs: abs(rel), rel };
}

function timestamp(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

// ── Tools ───────────────────────────────────────────────────────────

// 1. VAULT STATUS
server.tool(
  "vault_status",
  "Get vault index stats: total files, directories, file type breakdown, and index health.",
  {},
  async () => {
    await vault.waitReady();
    const stats = vault.stats();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              vaultPath: VAULT_PATH,
              ...stats,
              topExtensions: Object.entries(stats.extensions)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// 2. READ NOTE
server.tool(
  "read_note",
  "Read a note from the vault. Supports fuzzy path resolution: exact path, stem name, or partial path. Returns file content and metadata.",
  { path: z.string().describe("Relative path, filename, or stem (e.g. '01-Daily/2025-03-04' or just '2025-03-04')") },
  async ({ path: notePath }) => {
    await vault.waitReady();
    const resolved = resolveOrFail(notePath);
    try {
      const content = await readFile(resolved.abs, "utf-8");
      const entry = vault.get(resolved.rel);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              path: resolved.rel,
              size: entry?.size ?? content.length,
              mtime: entry?.mtime ? new Date(entry.mtime).toISOString() : null,
              content,
            }),
          },
        ],
      };
    } catch {
      return { content: [{ type: "text", text: `ERROR: File not found: ${notePath} (resolved to: ${resolved.rel})` }], isError: true };
    }
  },
);

// 3. WRITE NOTE
server.tool(
  "write_note",
  "Create or overwrite a note. Creates parent directories automatically. Use for new files or full replacements.",
  {
    path: z.string().describe("Relative path for the note (e.g. '00-Inbox/new-idea.md')"),
    content: z.string().describe("Full content to write"),
    overwrite: z.boolean().default(false).describe("Set true to overwrite existing files. Safety guard."),
  },
  async ({ path: notePath, content, overwrite }) => {
    await vault.waitReady();
    const rel = ensureMd(notePath.replace(/\\/g, "/").replace(/^\/+/, ""));
    const absPath = abs(rel);

    if (!overwrite && vault.has(rel)) {
      return {
        content: [{ type: "text", text: `ERROR: File already exists: ${rel}. Set overwrite=true to replace.` }],
        isError: true,
      };
    }

    await ensureDir(absPath);
    await writeFile(absPath, content, "utf-8");
    return { content: [{ type: "text", text: `OK: Written ${rel} (${content.length} bytes)` }] };
  },
);

// 4. APPEND NOTE
server.tool(
  "append_note",
  "Append content to an existing note or create it if it doesn't exist. Perfect for daily notes, inbox capture, and incremental logging.",
  {
    path: z.string().describe("Relative path or stem of the note"),
    content: z.string().describe("Content to append"),
    separator: z.string().default("\n").describe("Separator before appended content (default: newline)"),
    create_if_missing: z.boolean().default(true).describe("Create the file if it doesn't exist"),
    add_timestamp: z.boolean().default(false).describe("Prepend a timestamp to the appended block"),
  },
  async ({ path: notePath, content, separator, create_if_missing, add_timestamp }) => {
    await vault.waitReady();
    const resolved = resolveOrFail(notePath);
    const prefix = add_timestamp ? `\n<!-- ${timestamp()} -->\n` : "";
    const payload = separator + prefix + content;

    try {
      await appendFile(resolved.abs, payload, "utf-8");
      return { content: [{ type: "text", text: `OK: Appended ${payload.length} bytes to ${resolved.rel}` }] };
    } catch {
      if (create_if_missing) {
        await ensureDir(resolved.abs);
        await writeFile(resolved.abs, prefix + content, "utf-8");
        return { content: [{ type: "text", text: `OK: Created ${resolved.rel} with ${content.length} bytes` }] };
      }
      return { content: [{ type: "text", text: `ERROR: File not found: ${resolved.rel}` }], isError: true };
    }
  },
);

// 5. EDIT NOTE (str_replace style)
server.tool(
  "edit_note",
  "In-place edit: find and replace a unique string in a note. The old_str must appear exactly once. Atomic read-modify-write.",
  {
    path: z.string().describe("Relative path or stem of the note"),
    old_str: z.string().describe("Exact string to find (must be unique in the file)"),
    new_str: z.string().describe("Replacement string (empty string to delete)"),
  },
  async ({ path: notePath, old_str, new_str }) => {
    await vault.waitReady();
    const resolved = resolveOrFail(notePath);

    let content: string;
    try {
      content = await readFile(resolved.abs, "utf-8");
    } catch {
      return { content: [{ type: "text", text: `ERROR: File not found: ${resolved.rel}` }], isError: true };
    }

    const occurrences = content.split(old_str).length - 1;
    if (occurrences === 0) {
      return { content: [{ type: "text", text: `ERROR: String not found in ${resolved.rel}. Check exact spacing/newlines.` }], isError: true };
    }
    if (occurrences > 1) {
      return {
        content: [{ type: "text", text: `ERROR: String found ${occurrences} times in ${resolved.rel}. Must be unique. Add surrounding context to disambiguate.` }],
        isError: true,
      };
    }

    const updated = content.replace(old_str, new_str);
    await writeFile(resolved.abs, updated, "utf-8");
    return { content: [{ type: "text", text: `OK: Edited ${resolved.rel} (replaced ${old_str.length} → ${new_str.length} chars)` }] };
  },
);

// 6. DELETE NOTE
server.tool(
  "delete_note",
  "Delete a note from the vault. Moves to .trash by default for safety.",
  {
    path: z.string().describe("Relative path or stem of the note"),
    permanent: z.boolean().default(false).describe("Skip trash and delete permanently"),
  },
  async ({ path: notePath, permanent }) => {
    await vault.waitReady();
    const resolved = resolveOrFail(notePath);

    try {
      if (permanent) {
        await unlink(resolved.abs);
      } else {
        const trashDir = path.join(VAULT_PATH!, ".trash");
        await mkdir(trashDir, { recursive: true });
        const trashPath = path.join(trashDir, path.basename(resolved.abs));
        const content = await readFile(resolved.abs, "utf-8");
        await writeFile(trashPath, content, "utf-8");
        await unlink(resolved.abs);
      }
      return { content: [{ type: "text", text: `OK: Deleted ${resolved.rel}${permanent ? " (permanent)" : " (moved to .trash)"}` }] };
    } catch {
      return { content: [{ type: "text", text: `ERROR: Could not delete: ${resolved.rel}` }], isError: true };
    }
  },
);

// 7. LIST DIRECTORY
server.tool(
  "list_dir",
  "List files in a vault directory. Returns indexed metadata with created/modified timestamps. Sort by name, date, or size.",
  {
    path: z.string().default(".").describe("Relative directory path (default: vault root)"),
    recursive: z.boolean().default(false).describe("Include subdirectories recursively"),
    pattern: z.string().optional().describe("Glob pattern to filter (e.g. '*.md', '**/*.canvas')"),
    sort_by: z.enum(["name", "created", "modified", "size"]).default("name").describe("Sort field (default: name)"),
    sort_order: z.enum(["asc", "desc"]).default("asc").describe("Sort order (default: asc)"),
  },
  async ({ path: dirPath, recursive, pattern, sort_by, sort_order }) => {
    await vault.waitReady();

    let files;
    if (recursive && pattern) {
      const fullPattern = dirPath === "." ? pattern : `${dirPath}/${pattern}`;
      files = vault.glob(fullPattern);
    } else if (recursive) {
      files = vault.searchPaths(dirPath === "." ? "" : dirPath);
    } else {
      files = vault.listDir(dirPath);
    }

    let listing = files.map((f) => ({
      path: f.rel,
      ext: f.ext,
      size: f.size,
      created: new Date(f.ctime).toISOString(),
      modified: new Date(f.mtime).toISOString(),
    }));

    // Sort
    listing.sort((a, b) => {
      switch (sort_by) {
        case "name":     return a.path.localeCompare(b.path);
        case "created":  return new Date(a.created).getTime() - new Date(b.created).getTime();
        case "modified": return new Date(a.modified).getTime() - new Date(b.modified).getTime();
        case "size":     return a.size - b.size;
        default:         return 0;
      }
    });
    if (sort_order === "desc") listing.reverse();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ directory: dirPath, count: listing.length, files: listing }, null, 2),
        },
      ],
    };
  },
);

// 8. SEARCH VAULT (path-based, instant from index)
server.tool(
  "search_vault",
  "Search the vault index by filename or path. Instant — uses in-memory index, no disk scan.",
  {
    query: z.string().describe("Search query (matches against file paths)"),
    limit: z.number().default(20).describe("Max results to return"),
  },
  async ({ query, limit }) => {
    await vault.waitReady();
    const results = vault.searchPaths(query).slice(0, limit);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              query,
              count: results.length,
              results: results.map((f) => ({
                path: f.rel,
                size: f.size,
                modified: new Date(f.mtime).toISOString(),
              })),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// 9. SEARCH CONTENT (grep-like, reads files from disk)
server.tool(
  "search_content",
  "Full-text content search across vault files. Reads files from disk. Use search_vault for faster path-only search.",
  {
    query: z.string().describe("Text to search for (case-insensitive)"),
    extensions: z.array(z.string()).default([".md"]).describe("File extensions to search (default: ['.md'])"),
    limit: z.number().default(10).describe("Max files to return"),
    context_lines: z.number().default(2).describe("Lines of context around each match"),
  },
  async ({ query, extensions, limit, context_lines }) => {
    await vault.waitReady();
    const lower = query.toLowerCase();
    const candidates = vault.allFiles().filter((f) => extensions.includes(f.ext));
    const results: Array<{ path: string; matches: string[] }> = [];

    for (const file of candidates) {
      if (results.length >= limit) break;
      try {
        const content = await readFile(file.abs, "utf-8");
        if (!content.toLowerCase().includes(lower)) continue;

        const lines = content.split("\n");
        const matchLines: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(lower)) {
            const start = Math.max(0, i - context_lines);
            const end = Math.min(lines.length - 1, i + context_lines);
            const snippet = lines
              .slice(start, end + 1)
              .map((l, idx) => `${start + idx + 1}: ${l}`)
              .join("\n");
            matchLines.push(snippet);
          }
        }
        results.push({ path: file.rel, matches: matchLines });
      } catch {
        // Skip unreadable files
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ query, count: results.length, results }, null, 2),
        },
      ],
    };
  },
);

// 10. RECENT NOTES
server.tool(
  "recent_notes",
  "Get most recently modified notes. Instant from index — no disk reads.",
  {
    limit: z.number().default(15).describe("Number of recent files to return"),
    extension: z.string().optional().describe("Filter by extension (e.g. '.md')"),
  },
  async ({ limit, extension }) => {
    await vault.waitReady();
    let files = vault.recentFiles(limit * 2);
    if (extension) files = files.filter((f) => f.ext === extension);
    files = files.slice(0, limit);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              count: files.length,
              files: files.map((f) => ({
                path: f.rel,
                modified: new Date(f.mtime).toISOString(),
                size: f.size,
              })),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// 11. BATCH OPERATIONS
const BatchOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("read"),
    path: z.string(),
  }),
  z.object({
    op: z.literal("write"),
    path: z.string(),
    content: z.string(),
    overwrite: z.boolean().default(false),
  }),
  z.object({
    op: z.literal("append"),
    path: z.string(),
    content: z.string(),
    separator: z.string().default("\n"),
    add_timestamp: z.boolean().default(false),
  }),
  z.object({
    op: z.literal("edit"),
    path: z.string(),
    old_str: z.string(),
    new_str: z.string(),
  }),
  z.object({
    op: z.literal("delete"),
    path: z.string(),
    permanent: z.boolean().default(false),
  }),
  z.object({
    op: z.literal("rename"),
    from: z.string(),
    to: z.string(),
    update_links: z.boolean().default(true),
  }),
  z.object({
    op: z.literal("edit_regex"),
    path: z.string(),
    match: z.string(),
    replace: z.string(),
    flags: z.string().default("g"),
  }),
  z.object({
    op: z.literal("frontmatter"),
    path: z.string(),
    action: z.enum(["read", "set", "merge", "delete_keys"]),
    data: z.record(z.string(), z.any()).optional(),
    keys: z.array(z.string()).optional(),
  }),
]);

server.tool(
  "batch",
  "Execute multiple vault operations in a single call. Supports: read, write, append, edit, delete, rename, edit_regex, frontmatter. Sequential execution. Returns results array.",
  {
    operations: z.array(BatchOpSchema).min(1).max(50).describe("Array of operations to execute"),
  },
  async ({ operations }) => {
    await vault.waitReady();
    const results: Array<{ index: number; op: string; status: "ok" | "error"; detail: string; content?: string }> = [];

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      try {
        switch (op.op) {
          case "read": {
            const resolved = resolveOrFail(op.path);
            const content = await readFile(resolved.abs, "utf-8");
            results.push({ index: i, op: "read", status: "ok", detail: resolved.rel, content });
            break;
          }
          case "write": {
            const rel = ensureMd(op.path.replace(/\\/g, "/").replace(/^\/+/, ""));
            const absPath = abs(rel);
            if (!op.overwrite && vault.has(rel)) {
              results.push({ index: i, op: "write", status: "error", detail: `Already exists: ${rel}` });
            } else {
              await ensureDir(absPath);
              await writeFile(absPath, op.content, "utf-8");
              results.push({ index: i, op: "write", status: "ok", detail: `Written: ${rel}` });
            }
            break;
          }
          case "append": {
            const resolved = resolveOrFail(op.path);
            const prefix = op.add_timestamp ? `\n<!-- ${timestamp()} -->\n` : "";
            const payload = op.separator + prefix + op.content;
            try {
              await appendFile(resolved.abs, payload, "utf-8");
              results.push({ index: i, op: "append", status: "ok", detail: `Appended to: ${resolved.rel}` });
            } catch {
              await ensureDir(resolved.abs);
              await writeFile(resolved.abs, prefix + op.content, "utf-8");
              results.push({ index: i, op: "append", status: "ok", detail: `Created: ${resolved.rel}` });
            }
            break;
          }
          case "edit": {
            const resolved = resolveOrFail(op.path);
            const content = await readFile(resolved.abs, "utf-8");
            const count = content.split(op.old_str).length - 1;
            if (count !== 1) {
              results.push({
                index: i,
                op: "edit",
                status: "error",
                detail: count === 0 ? `String not found in ${resolved.rel}` : `String found ${count} times in ${resolved.rel}`,
              });
            } else {
              await writeFile(resolved.abs, content.replace(op.old_str, op.new_str), "utf-8");
              results.push({ index: i, op: "edit", status: "ok", detail: `Edited: ${resolved.rel}` });
            }
            break;
          }
          case "delete": {
            const resolved = resolveOrFail(op.path);
            if (op.permanent) {
              await unlink(resolved.abs);
            } else {
              const trashDir = path.join(VAULT_PATH!, ".trash");
              await mkdir(trashDir, { recursive: true });
              const c = await readFile(resolved.abs, "utf-8");
              await writeFile(path.join(trashDir, path.basename(resolved.abs)), c, "utf-8");
              await unlink(resolved.abs);
            }
            results.push({ index: i, op: "delete", status: "ok", detail: `Deleted: ${resolved.rel}` });
            break;
          }
          case "rename": {
            const fromResolved = vault.resolve(op.from);
            const fromRel = fromResolved?.rel ?? op.from;
            const fromAbs = path.join(VAULT_PATH!, fromRel);
            const toAbs = path.join(VAULT_PATH!, op.to);
            await mkdir(path.dirname(toAbs), { recursive: true });
            await rename(fromAbs, toAbs);
            let linksUpdated = 0;
            if (op.update_links) {
              const linkResult = await updateWikilinks(VAULT_PATH!, vault, fromRel, op.to, false);
              linksUpdated = linkResult.totalLinks;
            }
            results.push({ index: i, op: "rename", status: "ok", detail: `Renamed: ${fromRel} → ${op.to} (${linksUpdated} links updated)` });
            break;
          }
          case "edit_regex": {
            const resolved = resolveOrFail(op.path);
            const content = await readFile(resolved.abs, "utf-8");
            let regex: RegExp;
            try {
              regex = new RegExp(op.match, op.flags);
            } catch (err: any) {
              results.push({ index: i, op: "edit_regex", status: "error", detail: `Invalid regex: ${err.message}` });
              break;
            }
            const newContent = content.replace(regex, op.replace);
            if (newContent === content) {
              results.push({ index: i, op: "edit_regex", status: "ok", detail: `No matches in ${resolved.rel}` });
            } else {
              await writeFile(resolved.abs, newContent, "utf-8");
              results.push({ index: i, op: "edit_regex", status: "ok", detail: `Regex applied to ${resolved.rel}` });
            }
            break;
          }
          case "frontmatter": {
            const resolved = resolveOrFail(op.path);
            let content: string;
            try { content = await readFile(resolved.abs, "utf-8"); } catch { content = ""; }
            const parsed = parseFrontmatter(content);
            switch (op.action) {
              case "read":
                results.push({ index: i, op: "frontmatter", status: "ok", detail: resolved.rel, content: JSON.stringify(parsed.frontmatter) });
                break;
              case "set":
                if (op.data) {
                  await writeFile(resolved.abs, serializeFrontmatter(op.data) + "\n" + parsed.body, "utf-8");
                  results.push({ index: i, op: "frontmatter", status: "ok", detail: `Set frontmatter: ${resolved.rel}` });
                }
                break;
              case "merge":
                if (op.data) {
                  const merged = { ...parsed.frontmatter, ...op.data };
                  await writeFile(resolved.abs, serializeFrontmatter(merged) + "\n" + parsed.body, "utf-8");
                  results.push({ index: i, op: "frontmatter", status: "ok", detail: `Merged frontmatter: ${resolved.rel}` });
                }
                break;
              case "delete_keys":
                if (op.keys) {
                  const updated = { ...parsed.frontmatter };
                  for (const key of op.keys) delete updated[key];
                  const newFm = Object.keys(updated).length > 0 ? serializeFrontmatter(updated) + "\n" + parsed.body : parsed.body;
                  await writeFile(resolved.abs, newFm, "utf-8");
                  results.push({ index: i, op: "frontmatter", status: "ok", detail: `Deleted keys from ${resolved.rel}` });
                }
                break;
            }
            break;
          }
        }
      } catch (err: any) {
        results.push({ index: i, op: op.op, status: "error", detail: err?.message ?? String(err) });
      }
    }

    const okCount = results.filter((r) => r.status === "ok").length;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              total: operations.length,
              succeeded: okCount,
              failed: operations.length - okCount,
              results,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// 12. DAILY NOTE helper
server.tool(
  "daily_note",
  "Quick access to today's daily note (or a specific date). Creates from template if missing. Perfect for rapid capture.",
  {
    date: z.string().optional().describe("Date in YYYY-MM-DD format (default: today)"),
    folder: z.string().default("01-Daily").describe("Daily notes folder"),
    content_to_append: z.string().optional().describe("Content to append to the daily note"),
    template: z.string().optional().describe("Template content if creating a new daily note"),
  },
  async ({ date, folder, content_to_append, template }) => {
    await vault.waitReady();
    const targetDate = date ?? new Date().toISOString().slice(0, 10);
    const relPath = `${folder}/${targetDate}.md`;
    const absPath = abs(relPath);

    let existed = vault.has(relPath);
    let content: string;

    if (!existed) {
      await ensureDir(absPath);
      const initial = template ?? `# ${targetDate}\n\n`;
      await writeFile(absPath, initial, "utf-8");
      content = initial;
    } else {
      content = await readFile(absPath, "utf-8");
    }

    if (content_to_append) {
      const payload = `\n${content_to_append}`;
      await appendFile(absPath, payload, "utf-8");
      content += payload;
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            path: relPath,
            created: !existed,
            appended: !!content_to_append,
            content,
          }),
        },
      ],
    };
  },
);

// ── Canvas Tools ────────────────────────────────────────────────────

registerCanvasCreate(server, VAULT_PATH!, vault);
registerCanvasRead(server, VAULT_PATH!, vault);
registerCanvasPatch(server, VAULT_PATH!, vault);
registerCanvasRelayout(server, VAULT_PATH!, vault);

// ── File & Link Tools ──────────────────────────────────────────────

registerEditRegex(server, VAULT_PATH!, vault);
registerBatchRename(server, VAULT_PATH!, vault);
registerUpdateLinks(server, VAULT_PATH!, vault);
registerBacklinks(server, VAULT_PATH!, vault);
registerFrontmatter(server, VAULT_PATH!, vault);

// ── Search & Intelligence Tools ────────────────────────────────────

registerSmartSearch(server, VAULT_PATH!, vault);
registerSearchReindex(server, VAULT_PATH!, vault);
registerVaultThemes(server, VAULT_PATH!, vault);
registerVaultSuggest(server, VAULT_PATH!, vault);

// ── Boot ─────────────────────────────────────────────────────────────

async function main() {
  console.error(`[obsidian-forge-mcp] Starting...`);
  console.error(`[obsidian-forge-mcp] Vault: ${VAULT_PATH}`);

  // Init index in background, server starts immediately
  vault.init().catch((err) => {
    console.error("[obsidian-forge-mcp] Index init failed:", err);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[obsidian-forge-mcp] Connected via stdio`);
}

main().catch((err) => {
  console.error("[obsidian-forge-mcp] Fatal:", err);
  process.exit(1);
});
