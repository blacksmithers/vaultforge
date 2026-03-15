import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VaultIndex } from "../../vault-index.js";
import { escapeRegex, extractStem, getAllMdFiles } from "./link-utils.js";

/**
 * Core link-update logic, exported so batch_rename can call it directly.
 */
export async function updateWikilinks(
  vaultPath: string,
  vault: VaultIndex,
  oldPath: string,
  newPath: string,
  dryRun: boolean,
): Promise<{ filesScanned: number; filesUpdated: number; totalLinks: number; results: Array<{ path: string; links_updated: number }> }> {
  const oldRef = oldPath.replace(/\.md$/, "");
  const newRef = newPath.replace(/\.md$/, "");
  const oldStem = extractStem(oldPath);
  const newStem = extractStem(newPath);

  const escapedRef = escapeRegex(oldRef);
  const escapedStem = escapeRegex(oldStem);

  // Build replacement patterns (full path first, then stem)
  const patterns: Array<{ regex: RegExp; newBase: string }> = [
    {
      regex: new RegExp(`(!?\\[\\[)${escapedRef}(#[^\\]|]*)?(?:\\|([^\\]]*))?\\]\\]`, "g"),
      newBase: newRef,
    },
  ];

  if (oldStem !== newStem) {
    patterns.push({
      regex: new RegExp(`(!?\\[\\[)${escapedStem}(#[^\\]|]*)?(?:\\|([^\\]]*))?\\]\\]`, "g"),
      newBase: newStem,
    });
  }

  const allFiles = getAllMdFiles(vault);
  const results: Array<{ path: string; links_updated: number }> = [];
  let totalLinks = 0;

  for (const filePath of allFiles) {
    if (filePath === newPath) continue;

    const fullPath = path.join(vaultPath, filePath);
    let content: string;
    try {
      content = await readFile(fullPath, "utf-8");
    } catch {
      continue;
    }

    let newContent = content;
    let matchCount = 0;

    for (const { regex, newBase } of patterns) {
      newContent = newContent.replace(regex, (_match, prefix, heading, alias) => {
        matchCount++;
        const h = heading || "";
        const a = alias !== undefined ? `|${alias}` : "";
        return `${prefix}${newBase}${h}${a}]]`;
      });
    }

    if (matchCount > 0) {
      totalLinks += matchCount;
      results.push({ path: filePath, links_updated: matchCount });
      if (!dryRun) {
        await writeFile(fullPath, newContent, "utf-8");
      }
    }
  }

  return { filesScanned: allFiles.length, filesUpdated: results.length, totalLinks, results };
}

export function registerUpdateLinks(
  server: McpServer,
  vaultPath: string,
  vault: VaultIndex,
): void {
  server.tool(
    "update_links",
    "Update all wikilinks across vault after moving/renaming a file. Handles all link forms: stem, path, alias, heading, embed. Dry run by default.",
    {
      old_path: z.string().describe("File path before the move/rename"),
      new_path: z.string().describe("File path after the move/rename"),
      dry_run: z.boolean().default(true).describe("Preview changes without writing (default: true)"),
    },
    async ({ old_path, new_path, dry_run }) => {
      await vault.waitReady();

      const result = await updateWikilinks(vaultPath, vault, old_path, new_path, dry_run);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                old_path,
                new_path,
                files_scanned: result.filesScanned,
                files_updated: result.filesUpdated,
                total_links_updated: result.totalLinks,
                dry_run,
                results: result.results,
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
