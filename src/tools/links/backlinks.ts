import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { VaultIndex } from "../../vault-index.js";
import { extractStem, getAllMdFiles, findLinksInContent, type LinkMatch } from "./link-utils.js";

export function registerBacklinks(
  server: McpServer,
  vaultPath: string,
  vault: VaultIndex,
): void {
  server.tool(
    "backlinks",
    "Find all files that link to a given file. Returns source files, link text, line numbers, context, and embed detection. Impact analysis before move/delete.",
    {
      path: z.string().describe("Target file path or stem"),
      include_embeds: z.boolean().default(true).describe("Include ![[embed]] links (default: true)"),
    },
    async ({ path: targetPath, include_embeds }) => {
      await vault.waitReady();

      const resolved = vault.resolve(targetPath);
      const rel = resolved?.rel ?? targetPath;
      const ref = rel.replace(/\.md$/, "");
      const stem = extractStem(rel);

      const allFiles = getAllMdFiles(vault);
      const results: Array<{ path: string; links: LinkMatch[] }> = [];
      let totalCount = 0;

      for (const filePath of allFiles) {
        if (filePath === rel) continue;

        const fullPath = path.join(vaultPath, filePath);
        let content: string;
        try {
          content = await readFile(fullPath, "utf-8");
        } catch {
          continue;
        }

        const matches = findLinksInContent(content, ref, stem, include_embeds);
        if (matches.length > 0) {
          totalCount += matches.length;
          results.push({ path: filePath, links: matches });
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                target: rel,
                backlink_count: totalCount,
                file_count: results.length,
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
