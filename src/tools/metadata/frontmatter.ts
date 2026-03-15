import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VaultIndex } from "../../vault-index.js";

interface ParsedFrontmatter {
  frontmatter: Record<string, any>;
  body: string;
  hasFrontmatter: boolean;
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content, hasFrontmatter: false };

  const fm: Record<string, any> = {};
  let currentKey: string | null = null;
  let listItems: string[] = [];
  let inList = false;

  for (const line of match[1].split("\n")) {
    // YAML list item (- value)
    if (inList && /^\s+-\s+(.*)$/.test(line)) {
      const itemMatch = line.match(/^\s+-\s+(.*)$/);
      if (itemMatch) {
        listItems.push(parseYamlValue(itemMatch[1].trim()));
      }
      continue;
    }

    // If we were collecting list items, save them
    if (inList && currentKey) {
      fm[currentKey] = listItems;
      inList = false;
      listItems = [];
      currentKey = null;
    }

    const kv = line.match(/^([\w][\w-]*):\s*(.*)$/);
    if (!kv) continue;

    const key = kv[1];
    const rawValue = kv[2].trim();

    // Check if this is the start of a YAML list
    if (rawValue === "") {
      currentKey = key;
      inList = true;
      listItems = [];
      continue;
    }

    // Inline array: [val1, val2]
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      fm[key] = rawValue
        .slice(1, -1)
        .split(",")
        .map((v) => parseYamlValue(v.trim()))
        .filter((v) => v !== "");
    } else {
      fm[key] = parseYamlValue(rawValue);
    }
  }

  // Final list collection
  if (inList && currentKey) {
    fm[currentKey] = listItems;
  }

  return { frontmatter: fm, body: match[2], hasFrontmatter: true };
}

function parseYamlValue(value: string): any {
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  // Strip surrounding quotes
  return value.replace(/^["']|["']$/g, "");
}

export function serializeFrontmatter(fm: Record<string, any>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(fm)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(", ")}]`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  return `---\n${lines.join("\n")}\n---`;
}

export function registerFrontmatter(
  server: McpServer,
  vaultPath: string,
  vault: VaultIndex,
): void {
  server.tool(
    "frontmatter",
    "Read/write/merge YAML frontmatter as structured data. No string parsing needed. Actions: read, set, merge, delete_keys.",
    {
      path: z.string().describe("File path or stem"),
      action: z.enum(["read", "set", "merge", "delete_keys"]).describe("Operation to perform"),
      data: z.record(z.string(), z.any()).optional().describe("Data for set/merge actions"),
      keys: z.array(z.string()).optional().describe("Keys to remove for delete_keys action"),
    },
    async ({ path: filePath, action, data, keys }) => {
      await vault.waitReady();

      const resolved = vault.resolve(filePath);
      const rel = resolved?.rel ?? filePath;
      const fullPath = path.join(vaultPath, rel);

      let content: string;
      try {
        content = await readFile(fullPath, "utf-8");
      } catch {
        if (action === "read") {
          return {
            content: [{ type: "text", text: `ERROR: File not found: ${rel}` }],
            isError: true,
          };
        }
        // For write actions, start with empty content
        content = "";
      }

      const parsed = parseFrontmatter(content);

      switch (action) {
        case "read": {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    path: rel,
                    frontmatter: parsed.frontmatter,
                    has_frontmatter: parsed.hasFrontmatter,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        case "set": {
          if (!data) {
            return {
              content: [{ type: "text", text: "ERROR: 'data' is required for 'set' action" }],
              isError: true,
            };
          }
          const before = { ...parsed.frontmatter };
          const newContent = serializeFrontmatter(data) + "\n" + parsed.body;
          await writeFile(fullPath, newContent, "utf-8");
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ path: rel, action: "set", before, after: data }, null, 2),
              },
            ],
          };
        }

        case "merge": {
          if (!data) {
            return {
              content: [{ type: "text", text: "ERROR: 'data' is required for 'merge' action" }],
              isError: true,
            };
          }
          const before = { ...parsed.frontmatter };
          const merged = { ...parsed.frontmatter, ...data };
          const newContent = serializeFrontmatter(merged) + "\n" + parsed.body;
          await writeFile(fullPath, newContent, "utf-8");
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ path: rel, action: "merge", before, after: merged }, null, 2),
              },
            ],
          };
        }

        case "delete_keys": {
          if (!keys || keys.length === 0) {
            return {
              content: [{ type: "text", text: "ERROR: 'keys' is required for 'delete_keys' action" }],
              isError: true,
            };
          }
          const before = { ...parsed.frontmatter };
          const updated = { ...parsed.frontmatter };
          for (const key of keys) {
            delete updated[key];
          }
          const newContent =
            Object.keys(updated).length > 0
              ? serializeFrontmatter(updated) + "\n" + parsed.body
              : parsed.body;
          await writeFile(fullPath, newContent, "utf-8");
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { path: rel, action: "delete_keys", keys_deleted: keys, before, after: updated },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      }
    },
  );
}
