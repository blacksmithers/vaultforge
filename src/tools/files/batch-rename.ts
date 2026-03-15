import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rename, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { VaultIndex } from "../../vault-index.js";
import { updateWikilinks } from "../links/update-links.js";

export function registerBatchRename(
  server: McpServer,
  vaultPath: string,
  vault: VaultIndex,
): void {
  server.tool(
    "batch_rename",
    "Rename/move files. Explicit pairs or regex pattern on filenames. Auto-updates wikilinks. Dry run by default. Atomic fs.rename preserves metadata.",
    {
      renames: z
        .array(z.object({ from: z.string(), to: z.string() }))
        .optional()
        .describe("Mode 1: explicit rename pairs"),
      pattern: z
        .object({
          directory: z.string().describe("Directory to search"),
          match: z.string().describe("Regex applied to filename only"),
          replace: z.string().describe("Replacement string ($1, $2 for capture groups)"),
          filter_ext: z.string().default(".md").describe("Extension filter (default: .md)"),
          recursive: z.boolean().default(false).describe("Search subdirectories"),
        })
        .optional()
        .describe("Mode 2: regex pattern on filenames"),
      dry_run: z.boolean().default(true).describe("Preview without executing (default: true)"),
      update_links: z.boolean().default(true).describe("Auto-update wikilinks after rename (default: true)"),
    },
    async ({ renames, pattern, dry_run, update_links: doUpdateLinks }) => {
      await vault.waitReady();

      // Build rename pairs
      let pairs: Array<{ from: string; to: string }> = [];

      if (renames && renames.length > 0) {
        // Mode 1: explicit pairs
        for (const r of renames) {
          const fromResolved = vault.resolve(r.from);
          const from = fromResolved?.rel ?? r.from;
          pairs.push({ from, to: r.to });
        }
      } else if (pattern) {
        // Mode 2: regex on filenames
        let regex: RegExp;
        try {
          regex = new RegExp(pattern.match);
        } catch (err: any) {
          return {
            content: [{ type: "text", text: `ERROR: Invalid regex: ${err.message}` }],
            isError: true,
          };
        }

        const searchDir = pattern.directory;
        const files = pattern.recursive
          ? vault.searchPaths(searchDir === "." ? "" : searchDir)
          : vault.listDir(searchDir);

        for (const f of files) {
          if (f.ext !== pattern.filter_ext) continue;
          const filename = path.basename(f.rel);
          if (!regex.test(filename)) continue;
          const newFilename = filename.replace(regex, pattern.replace);
          if (newFilename === filename) continue;
          pairs.push({
            from: f.rel,
            to: path.join(path.dirname(f.rel), newFilename).replace(/\\/g, "/"),
          });
        }
      } else {
        return {
          content: [{ type: "text", text: "ERROR: Provide either 'renames' or 'pattern'" }],
          isError: true,
        };
      }

      if (pairs.length === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({ renamed: 0, results: [], dry_run, message: "No files matched" }, null, 2) }],
        };
      }

      // Pre-flight: detect conflicts
      const targets = new Set<string>();
      const sources = new Set<string>();
      for (const p of pairs) {
        if (targets.has(p.to)) {
          return {
            content: [{ type: "text", text: `ERROR: Duplicate target: ${p.to}` }],
            isError: true,
          };
        }
        targets.add(p.to);
        sources.add(p.from);
      }

      // Detect circular renames
      for (const p of pairs) {
        if (sources.has(p.to) && targets.has(p.from)) {
          return {
            content: [{ type: "text", text: `ERROR: Circular rename detected: ${p.from} ↔ ${p.to}` }],
            isError: true,
          };
        }
      }

      // Check target conflicts with existing files
      for (const p of pairs) {
        if (!sources.has(p.to) && vault.has(p.to)) {
          return {
            content: [{ type: "text", text: `ERROR: Target already exists: ${p.to}` }],
            isError: true,
          };
        }
      }

      const results: Array<{ from: string; to: string; links_affected: number }> = [];
      let totalLinksUpdated = 0;

      for (const p of pairs) {
        let linksAffected = 0;

        if (!dry_run) {
          const fromAbs = path.join(vaultPath, p.from);
          const toAbs = path.join(vaultPath, p.to);
          await mkdir(path.dirname(toAbs), { recursive: true });
          await rename(fromAbs, toAbs);
        }

        if (doUpdateLinks) {
          const linkResult = await updateWikilinks(vaultPath, vault, p.from, p.to, dry_run);
          linksAffected = linkResult.totalLinks;
          totalLinksUpdated += linksAffected;
        }

        results.push({ from: p.from, to: p.to, links_affected: linksAffected });
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                renamed: pairs.length,
                links_updated: totalLinksUpdated,
                dry_run,
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
}
