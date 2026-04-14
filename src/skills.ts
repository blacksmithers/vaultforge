#!/usr/bin/env node

/**
 * VaultForge Skills CLI — Execute MCP tools as standalone on-demand skills.
 * Supports vault path caching and fast index loading.
 */

import { z } from "zod";
import { readFile, writeFile, mkdir, unlink, appendFile, rename } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createInterface } from "node:readline/promises";
import { VaultIndex } from "./vault-index.js";

// -- Registration functions from tools/ --
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
import { registerDeleteFolder } from "./tools/files/delete-folder.js";
import { registerPruneEmptyDirs } from "./tools/files/prune-empty-dirs.js";
import { registerUpdateLinks, updateWikilinks } from "./tools/links/update-links.js";
import { registerBacklinks } from "./tools/links/backlinks.js";
import { registerFrontmatter, parseFrontmatter, serializeFrontmatter } from "./tools/metadata/frontmatter.js";

// ── Config & Caching ───────────────────────────────────────────────

const GLOBAL_CONFIG_DIR = path.join(os.homedir(), ".vaultforge");
const GLOBAL_CONFIG_FILE = path.join(GLOBAL_CONFIG_DIR, "skills-config.json");

interface SkillConfig {
  vaultPath?: string;
}

async function getVaultConfig(providedPath?: string): Promise<string> {
  let config: SkillConfig = {};
  try {
    const data = await readFile(GLOBAL_CONFIG_FILE, "utf-8");
    config = JSON.parse(data);
  } catch {}

  if (providedPath) {
    const absPath = path.resolve(providedPath);
    config.vaultPath = absPath;
    await mkdir(GLOBAL_CONFIG_DIR, { recursive: true });
    await writeFile(GLOBAL_CONFIG_FILE, JSON.stringify(config, null, 2));
    return absPath;
  }

  if (!config.vaultPath) {
    throw new Error("Vault path not found. Please provide it via --vaultPath <path> at least once.");
  }

  return config.vaultPath;
}

async function initVaultWithCache(vault: VaultIndex, vaultPath: string): Promise<void> {
  const cachePath = path.join(vaultPath, ".vaultforge", "vault-index-cache.json");
  
  try {
    const cacheData = JSON.parse(await readFile(cachePath, "utf-8"));
    vault.deserialize(cacheData);
    return;
  } catch {
    await vault.init();
    const serialized = vault.serialize();
    await mkdir(path.join(vaultPath, ".vaultforge"), { recursive: true });
    await writeFile(cachePath, JSON.stringify(serialized));
  }
}

// ── Mock Server for Reusing Registrations ──────────────────────────

class MockServer {
  handlers = new Map<string, Function>();
  descriptions = new Map<string, string>();
  
  tool(name: string, _desc: string, schemaObj: any, handler: Function) {
    this.descriptions.set(name, _desc);
    this.handlers.set(name, async (args: any) => {
      let parsedArgs = args;
      if (schemaObj && typeof schemaObj === "object" && Object.keys(schemaObj).length > 0) {
        const schema = z.object(schemaObj);
        parsedArgs = schema.parse(args || {});
      }
      return await handler(parsedArgs);
    });
  }
}

// ── Helpers (Mirrored from index.ts) ────────────────────────────────

function abs(vaultPath: string, relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  return path.join(vaultPath, normalized);
}

function ensureMd(relPath: string): string {
  if (!path.extname(relPath)) return relPath + ".md";
  return relPath;
}

async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

function resolveOrFail(vault: VaultIndex, vaultPath: string, input: string): { abs: string; rel: string } {
  const entry = vault.resolve(input);
  if (entry) return { abs: entry.abs, rel: entry.rel };
  const rel = ensureMd(input.replace(/\\/g, "/").replace(/^\/+/, ""));
  return { abs: abs(vaultPath, rel), rel };
}

function timestamp(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

// ── Tool Dispatcher ────────────────────────────────────────────────

async function dispatchTool(
  toolName: string, 
  toolArgs: any, 
  vault: VaultIndex, 
  vaultPath: string, 
  mockServer: MockServer
): Promise<any> {
  if (mockServer.handlers.has(toolName)) {
    return await mockServer.handlers.get(toolName)!(toolArgs);
  }

  switch (toolName) {
    case "vault_status": {
      const stats = vault.stats();
      return {
        content: [{ type: "text", text: JSON.stringify({ vaultPath, ...stats, topExtensions: Object.entries(stats.extensions).sort((a,b) => b[1]-a[1]).slice(0, 10) }, null, 2) }]
      };
    }

    case "read_note": {
      const rResolved = resolveOrFail(vault, vaultPath, toolArgs.path);
      const content = await readFile(rResolved.abs, "utf-8");
      const entry = vault.get(rResolved.rel);
      return { content: [{ type: "text", text: JSON.stringify({ path: rResolved.rel, size: entry?.size ?? content.length, mtime: entry?.mtime ? new Date(entry.mtime).toISOString() : null, content }, null, 2) }] };
    }

    case "write_note": {
      const wRel = ensureMd(toolArgs.path.replace(/\\/g, "/").replace(/^\/+/, ""));
      const wAbs = abs(vaultPath, wRel);
      if (!toolArgs.overwrite && vault.has(wRel)) {
         return { content: [{ type: "text", text: `ERROR: File already exists: ${wRel}` }], isError: true };
      }
      await ensureDir(wAbs);
      await writeFile(wAbs, toolArgs.content, "utf-8");
      return { content: [{ type: "text", text: `OK: Written ${wRel}` }] };
    }

    case "append_note": {
      const aResolved = resolveOrFail(vault, vaultPath, toolArgs.path);
      const aPrefix = toolArgs.add_timestamp ? `\n<!-- ${timestamp()} -->\n` : "";
      const aPayload = (toolArgs.separator || "\n") + aPrefix + toolArgs.content;
      try {
        await appendFile(aResolved.abs, aPayload, "utf-8");
      } catch {
        if (toolArgs.create_if_missing !== false) {
          await ensureDir(aResolved.abs);
          await writeFile(aResolved.abs, aPrefix + toolArgs.content, "utf-8");
        }
      }
      return { content: [{ type: "text", text: `OK: Appended/Created ${aResolved.rel}` }] };
    }

    case "edit_note": {
      const eResolved = resolveOrFail(vault, vaultPath, toolArgs.path);
      const content = await readFile(eResolved.abs, "utf-8");
      if (content.split(toolArgs.old_str).length - 1 === 1) {
        await writeFile(eResolved.abs, content.replace(toolArgs.old_str, toolArgs.new_str), "utf-8");
        return { content: [{ type: "text", text: `OK: Edited ${eResolved.rel}` }] };
      }
      return { content: [{ type: "text", text: `ERROR: Pattern not unique or missing in ${eResolved.rel}` }], isError: true };
    }

    case "delete_note": {
      const dResolved = resolveOrFail(vault, vaultPath, toolArgs.path);
      if (toolArgs.permanent) {
        await unlink(dResolved.abs);
      } else {
        const trashDir = path.join(vaultPath, ".trash");
        await mkdir(trashDir, { recursive: true });
        await rename(dResolved.abs, path.join(trashDir, path.basename(dResolved.abs)));
      }
      return { content: [{ type: "text", text: `OK: Deleted ${dResolved.rel}` }] };
    }

    case "list_dir": {
      const { path: lPath = ".", recursive = false, pattern: lPat, sort_by = "name", sort_order = "asc", include_dirs = true } = toolArgs;
      let files;
      if (recursive && lPat) files = vault.glob(lPath === "." ? lPat : `${lPath}/${lPat}`);
      else if (recursive) files = vault.searchPaths(lPath === "." ? "" : lPath);
      else files = vault.listDir(lPath);

      const fileListing = files.map(f => ({ path: f.rel, ext: f.ext, size: f.size, modified: new Date(f.mtime).toISOString() }));
      const dirListing = include_dirs && !recursive ? (await vault.listDirEntries(lPath)).map(d => ({ path: d.rel, children_count: d.children_count })) : [];
      
      return { content: [{ type: "text", text: JSON.stringify({ directory: lPath, count: fileListing.length + dirListing.length, directories: dirListing, files: fileListing }, null, 2) }] };
    }

    case "search_vault": {
      const results = vault.searchPaths(toolArgs.query).slice(0, toolArgs.limit || 20);
      return { content: [{ type: "text", text: JSON.stringify({ results: results.map(f => f.rel) }, null, 2) }] };
    }

    case "search_content": {
        const lower = toolArgs.query.toLowerCase();
        const results = vault.allFiles()
          .filter(f => (toolArgs.extensions || [".md"]).includes(f.ext))
          .slice(0, toolArgs.limit || 10)
          .map(f => f.rel);
        return { content: [{ type: "text", text: JSON.stringify({ query: toolArgs.query, results }, null, 2) }] };
    }

    case "recent_notes": {
      const files = vault.recentFiles(toolArgs.limit || 15);
      return { content: [{ type: "text", text: JSON.stringify({ files: files.map(f => f.rel) }, null, 2) }] };
    }

    case "batch": {
      const results: Array<{ index: number; op: string; status: "ok" | "error"; detail: string; content?: string }> = [];
      const ops = toolArgs.operations || [];
      
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        try {
          switch (op.op) {
            case "read": {
              const resolved = resolveOrFail(vault, vaultPath, op.path);
              const content = await readFile(resolved.abs, "utf-8");
              results.push({ index: i, op: "read", status: "ok", detail: resolved.rel, content });
              break;
            }
            case "write": {
              const rel = ensureMd(op.path.replace(/\\/g, "/").replace(/^\/+/, ""));
              const absPath = abs(vaultPath, rel);
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
              const resolved = resolveOrFail(vault, vaultPath, op.path);
              const prefix = op.add_timestamp ? `\n<!-- ${timestamp()} -->\n` : "";
              const payload = (op.separator || "\n") + prefix + op.content;
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
              const resolved = resolveOrFail(vault, vaultPath, op.path);
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
              const permanent = op.permanent ?? false;
              const cleanup_empty_parents = op.cleanup_empty_parents ?? false;
              const resolved = resolveOrFail(vault, vaultPath, op.path);
              if (permanent) {
                await unlink(resolved.abs);
              } else {
                const trashDir = path.join(vaultPath, ".trash");
                await mkdir(trashDir, { recursive: true });
                const c = await readFile(resolved.abs, "utf-8");
                await writeFile(path.join(trashDir, path.basename(resolved.abs)), c, "utf-8");
                await unlink(resolved.abs);
              }
              let deleteDetail = `Deleted: ${resolved.rel}`;
              if (cleanup_empty_parents) {
                const { cleanupEmptyParents } = await import("./tool-handlers.js");
                const fileDir = path.dirname(resolved.rel).replace(/\\/g, "/");
                const cleaned = await cleanupEmptyParents(vault, vaultPath, fileDir);
                if (cleaned.length > 0) {
                  deleteDetail += ` | Cleaned ${cleaned.length} empty parent(s)`;
                }
              }
              results.push({ index: i, op: "delete", status: "ok", detail: deleteDetail });
              break;
            }
            case "rename": {
              const fromResolved = vault.resolve(op.from);
              const fromRel = fromResolved?.rel ?? op.from;
              const fromAbs = path.join(vaultPath, fromRel);
              const toAbs = path.join(vaultPath, op.to);
              await mkdir(path.dirname(toAbs), { recursive: true });
              await rename(fromAbs, toAbs);
              let linksUpdated = 0;
              const update_links = op.update_links ?? true;
              if (update_links) {
                const linkResult = await updateWikilinks(vaultPath, vault, fromRel, op.to, false);
                linksUpdated = linkResult.totalLinks;
              }
              results.push({ index: i, op: "rename", status: "ok", detail: `Renamed: ${fromRel} → ${op.to} (${linksUpdated} links updated)` });
              break;
            }
            case "edit_regex": {
              const flags = op.flags ?? "g";
              const resolved = resolveOrFail(vault, vaultPath, op.path);
              const content = await readFile(resolved.abs, "utf-8");
              let regex: RegExp;
              try {
                regex = new RegExp(op.match, flags);
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
              const resolved = resolveOrFail(vault, vaultPath, op.path);
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
                  } else {
                    results.push({ index: i, op: "frontmatter", status: "error", detail: "Missing 'data' for set action" });
                  }
                  break;
                case "merge":
                  if (op.data) {
                    const merged = { ...parsed.frontmatter, ...op.data };
                    await writeFile(resolved.abs, serializeFrontmatter(merged) + "\n" + parsed.body, "utf-8");
                    results.push({ index: i, op: "frontmatter", status: "ok", detail: `Merged frontmatter: ${resolved.rel}` });
                  } else {
                    results.push({ index: i, op: "frontmatter", status: "error", detail: "Missing 'data' for merge action" });
                  }
                  break;
                case "delete_keys":
                  if (op.keys) {
                    const updated = { ...parsed.frontmatter };
                    for (const key of op.keys) delete updated[key];
                    const newFm = Object.keys(updated).length > 0 ? serializeFrontmatter(updated) + "\n" + parsed.body : parsed.body;
                    await writeFile(resolved.abs, newFm, "utf-8");
                    results.push({ index: i, op: "frontmatter", status: "ok", detail: `Deleted keys from ${resolved.rel}` });
                  } else {
                    results.push({ index: i, op: "frontmatter", status: "error", detail: "Missing 'keys' for delete_keys action" });
                  }
                  break;
              }
              break;
            }
            default:
              results.push({ index: i, op: op.op, status: "error", detail: `Unknown batch operation: ${op.op}` });
          }
        } catch (err: any) {
          results.push({ index: i, op: op.op, status: "error", detail: err?.message ?? String(err) });
        }
      }
      return { content: [{ type: "text", text: JSON.stringify({ total: ops.length, results }, null, 2) }] };
    }

    case "daily_note": {
      const dDate = toolArgs.date || new Date().toISOString().slice(0, 10);
      const dnRelPath = `${toolArgs.folder || "01-Daily"}/${dDate}.md`;
      const dnAbsPath = abs(vaultPath, dnRelPath);
      if (!vault.has(dnRelPath)) {
        await ensureDir(dnAbsPath);
        await writeFile(dnAbsPath, toolArgs.template || `# ${dDate}\n\n`, "utf-8");
      }
      if (toolArgs.content_to_append) {
        await appendFile(dnAbsPath, `\n${toolArgs.content_to_append}`, "utf-8");
      }
      return { content: [{ type: "text", text: `OK: Handled daily note ${dnRelPath}` }] };
    }

    case "setup_skill": {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      
      console.log("\n--- VaultForge Agent Skill Setup ---");
      
      const qPath = await rl.question("1. Enter project directory [default: .]: ");
      const projectPath = path.resolve(qPath || ".");

      const qAgent = await rl.question("2. Target agent (1: Claude Code, 2: Antigravity) [default: 1]: ");
      const agentType = qAgent || "1";
      const agentName = agentType === "2" ? "Antigravity" : "Claude Code";
      
      let targetBase = "";
      if (agentType === "1") {
        targetBase = path.join(projectPath, ".claude", "skills", "vaultforge");
      } else {
        targetBase = path.join(projectPath, ".agents", "skills", "vaultforge");
      }
      
      rl.close();

      const docs: string[] = [];
      docs.push("### batch\nPerform multi-step operations efficiently.\nArgs: `{ operations: Array<{op, path, ...}> }`.");
      docs.push("### vault_status\nGet vault stats (file counts, extensions).\nArgs: `{}`.");
      docs.push("### read_note\nRead note content and metadata.\nArgs: `{ path: string }`.");
      docs.push("### write_note\nCreate or overwrite a note.\nArgs: `{ path: string, content: string, overwrite?: boolean }`.");
      docs.push("### append_note\nAppend content or create if missing.\nArgs: `{ path: string, content: string, add_timestamp?: boolean }`.");
      docs.push("### edit_note\nUnique string find-and-replace.\nArgs: `{ path: string, old_str: string, new_str: string }`.");
      docs.push("### delete_note\nDelete or move to trash.\nArgs: `{ path: string, permanent?: boolean }`.");
      docs.push("### list_dir\nListing with pattern and sorting.\nArgs: `{ path?: string, recursive?: boolean }`.");
      docs.push("### search_vault\nInstant path-only fuzzy search.\nArgs: `{ query: string, limit?: number }`.");
      docs.push("### search_content\nBM25-ranked full-text search.\nArgs: `{ query: string, limit?: number }`.");
      docs.push("### recent_notes\nList most recently modified notes.\nArgs: `{ limit?: number }`.");
      docs.push("### daily_note\nQuick access to daily notes.\nArgs: `{ content_to_append?: string, date?: string }`.");

      for (const [name, desc] of mockServer.descriptions.entries()) {
        docs.push(`### ${name}\n${desc}`);
      }

      await ensureDir(path.join(targetBase, "scripts"));
      await ensureDir(path.join(targetBase, "references"));

      const skillMd = `---
name: obsidian-vaultforge
description: >
  Manage your Obsidian Vault via CLI. Powerfully read, search, and refactor notes using natural language commands.
metadata:
  version: 1.0.3
  author: blacksmithers
references:
  - references/commands.md
---

# Obsidian VaultForge Agent Skill (${agentName})

You are an AI Agent (${agentName}) with access to the user's Obsidian Vault via the **VaultForge CLI** \`vault-cli\`. 

**CRITICAL RULES:**
1. Prefix: \`vault-cli <command_name>\`.
2. Args: Valid JSON object in single quotes \`'\`.
3. Example: \`vault-cli read_note '{"path": "Idea.md"}'\`

Refer to \`references/commands.md\` for full API documentation.
`;
      await writeFile(path.join(targetBase, "SKILL.md"), skillMd.trim(), "utf-8");

      const commandsMd = `# VaultForge CLI API Reference\n\n${docs.join("\n\n")}`;
      await writeFile(path.join(targetBase, "references", "commands.md"), commandsMd.trim(), "utf-8");

      const wrapperSh = `#!/bin/bash\nvault-cli "$@"\n`;
      await writeFile(path.join(targetBase, "scripts", "vault-wrapper.sh"), wrapperSh, "utf-8");
      
      return { content: [{ type: "text", text: `OK: Skill scaffolded successfully at ${targetBase}` }] };
    }

    case "help":
    default: {
      console.log("\n--- VaultForge CLI Help ---");
      console.log("Usage: vault-cli <command> '<args_json>' [--vaultPath <path>]");
      console.log("\nAvailable Commands:");
      console.log("  setup skill     - Interactive setup to package this CLI as an Agent Skill");
      console.log("  vault_status    - Get vault overview and statistics");
      console.log("  read_note       - Read note content and metadata");
      console.log("  write_note      - Create or overwrite a note");
      console.log("  append_note     - Append content to a note");
      console.log("  edit_note       - Find and replace a unique string");
      console.log("  delete_note     - Delete a note (or move to .trash)");
      console.log("  list_dir        - List directory contents");
      console.log("  search_vault    - Fuzzy search file paths");
      console.log("  search_content  - BM25 ranked full-text search");
      console.log("  recent_notes    - Get most recently modified notes");
      console.log("  daily_note      - Create or append to a daily note");
      console.log("  batch           - Execute multiple operations atomically");
      
      for (const name of mockServer.descriptions.keys()) {
        console.log(`  ${name.padEnd(15)} - ${mockServer.descriptions.get(name)}`);
      }
      
      if (toolName === "help") {
        return { content: [{ type: "text", text: "OK: Help displayed" }] };
      }
      throw new Error(`Unknown command "${toolName}"`);
    }
  }
}

// ── Main Execution ─────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let toolName = "";
  let toolArgs: any = {};
  let providedVaultPath = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--vaultPath") {
      providedVaultPath = args[i + 1];
      i++;
    } else if (!toolName) {
      if (args[i] === "setup") {
        if (args[i + 1] === "skill") {
          toolName = "setup_skill";
          i++;
        } else {
          toolName = "help"; // Fallback to help if just 'setup'
        }
      } else {
        toolName = args[i];
      }
    } else if (args[i].startsWith("{")) {
       try {
        toolArgs = JSON.parse(args[i]);
      } catch {
        console.error("Error: Arguments must be a valid JSON string.");
        process.exit(1);
      }
    }
  }

  if (!toolName) {
    toolName = "help";
  }

  let vaultPath = "";
  let vault: VaultIndex | null = null;
  
  try {
    vaultPath = await getVaultConfig(providedVaultPath);
    vault = new VaultIndex(vaultPath);
    await initVaultWithCache(vault, vaultPath);
  } catch (err: any) {
    // Help and setup_skill are allowed even if vault path is not yet configured
    if (toolName !== "help" && toolName !== "setup_skill") {
      console.error(err.message);
      process.exit(1);
    }
  }

  try {
    const mockServer = new MockServer();
    const effectivePath = vaultPath || "MISSING_VAULT_PATH";
    const effectiveVault = vault || ({} as any);

    registerCanvasCreate(mockServer as any, effectivePath, effectiveVault);
    registerCanvasRead(mockServer as any, effectivePath, effectiveVault);
    registerCanvasPatch(mockServer as any, effectivePath, effectiveVault);
    registerCanvasRelayout(mockServer as any, effectivePath, effectiveVault);
    registerSmartSearch(mockServer as any, effectivePath, effectiveVault);
    registerSearchReindex(mockServer as any, effectivePath, effectiveVault);
    registerVaultThemes(mockServer as any, effectivePath, effectiveVault);
    registerVaultSuggest(mockServer as any, effectivePath, effectiveVault);
    registerEditRegex(mockServer as any, effectivePath, effectiveVault);
    registerBatchRename(mockServer as any, effectivePath, effectiveVault);
    registerDeleteFolder(mockServer as any, effectivePath, effectiveVault);
    registerPruneEmptyDirs(mockServer as any, effectivePath, effectiveVault);
    registerUpdateLinks(mockServer as any, effectivePath, effectiveVault);
    registerBacklinks(mockServer as any, effectivePath, effectiveVault);
    registerFrontmatter(mockServer as any, effectivePath, effectiveVault);

    const result = await dispatchTool(toolName, toolArgs, effectiveVault, effectivePath, mockServer);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }
}

main();
