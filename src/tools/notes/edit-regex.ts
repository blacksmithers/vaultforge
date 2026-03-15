import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VaultIndex } from "../../vault-index.js";

export function registerEditRegex(
  server: McpServer,
  vaultPath: string,
  vault: VaultIndex,
): void {
  server.tool(
    "edit_regex",
    "Regex find-and-replace. Single file or grep-sub across a directory. Supports capture groups ($1, $2). Dry run by default.",
    {
      path: z.string().optional().describe("Single file path (mutually exclusive with search_paths)"),
      search_paths: z
        .object({
          directory: z.string().describe("Directory to search"),
          recursive: z.boolean().default(false).describe("Include subdirectories"),
          pattern_filter: z.string().default("*.md").describe("Glob pattern to filter files (default: *.md)"),
        })
        .optional()
        .describe("Multi-file mode: search across directory"),
      match: z.string().describe("Regex pattern to find"),
      replace: z.string().describe("Replacement string ($1, $2 for capture groups)"),
      flags: z.string().default("g").describe("Regex flags (default: 'g')"),
      max_replacements: z.number().optional().describe("Safety cap: max replacements per file"),
      dry_run: z.boolean().default(true).describe("Preview changes without writing (default: true)"),
    },
    async ({ path: filePath, search_paths, match, replace, flags, max_replacements, dry_run }) => {
      await vault.waitReady();

      // Validate regex
      let regex: RegExp;
      try {
        regex = new RegExp(match, flags);
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `ERROR: Invalid regex: ${err.message}` }],
          isError: true,
        };
      }

      // Build file list
      let filePaths: string[] = [];

      if (filePath) {
        const resolved = vault.resolve(filePath);
        filePaths = [resolved?.rel ?? filePath];
      } else if (search_paths) {
        const dir = search_paths.directory;
        let files = search_paths.recursive
          ? vault.searchPaths(dir === "." ? "" : dir)
          : vault.listDir(dir);

        // Apply glob filter
        if (search_paths.pattern_filter && search_paths.pattern_filter !== "*") {
          const extMatch = search_paths.pattern_filter.match(/^\*(\.\w+)$/);
          if (extMatch) {
            files = files.filter((f) => f.ext === extMatch[1]);
          }
        }

        filePaths = files.map((f) => f.rel);
      } else {
        return {
          content: [{ type: "text", text: "ERROR: Provide either 'path' or 'search_paths'" }],
          isError: true,
        };
      }

      const results: Array<{
        path: string;
        matches_found: number;
        replacements_made: number;
        preview: Array<{ original: string; replaced: string; context: string }>;
      }> = [];
      let totalMatches = 0;
      let totalReplacements = 0;

      // Ensure 'g' flag for matchAll
      const matchAllFlags = flags.includes("g") ? flags : flags + "g";
      const matchAllRegex = new RegExp(match, matchAllFlags);

      for (const fp of filePaths) {
        const fullPath = path.join(vaultPath, fp);
        let content: string;
        try {
          content = await readFile(fullPath, "utf-8");
        } catch {
          continue;
        }

        // Skip binary-looking files
        if (content.includes("\0")) continue;

        const matches = [...content.matchAll(matchAllRegex)];
        if (matches.length === 0) continue;

        let effectiveMatches = matches;
        if (max_replacements && matches.length > max_replacements) {
          effectiveMatches = matches.slice(0, max_replacements);
        }

        const replacementsCount = effectiveMatches.length;
        totalMatches += matches.length;
        totalReplacements += replacementsCount;

        // Generate preview (first 3 matches)
        const singleRegex = new RegExp(match, flags.replace("g", ""));
        const preview = effectiveMatches.slice(0, 3).map((m) => {
          const start = Math.max(0, m.index! - 30);
          const end = Math.min(content.length, m.index! + m[0].length + 30);
          return {
            original: m[0],
            replaced: m[0].replace(singleRegex, replace),
            context: content.slice(start, end),
          };
        });

        results.push({
          path: fp,
          matches_found: matches.length,
          replacements_made: replacementsCount,
          preview,
        });

        if (!dry_run) {
          let newContent: string;
          if (max_replacements) {
            // Limited replacements: replace only up to max
            let count = 0;
            newContent = content.replace(regex, (match, ...args) => {
              if (count >= max_replacements) return match;
              count++;
              // Reconstruct replacement with capture groups
              return match.replace(singleRegex, replace);
            });
          } else {
            newContent = content.replace(regex, replace);
          }
          if (newContent !== content) {
            await writeFile(fullPath, newContent, "utf-8");
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                files_searched: filePaths.length,
                files_matched: results.length,
                total_matches: totalMatches,
                total_replacements: totalReplacements,
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
