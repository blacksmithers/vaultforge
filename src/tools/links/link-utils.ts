import { readFile } from "node:fs/promises";
import path from "node:path";
import type { VaultIndex } from "../../vault-index.js";

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractStem(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}

/**
 * Build regex patterns to match wikilinks referencing a given file.
 * Returns patterns ordered from most specific (full path) to least (stem only).
 */
export function buildWikiLinkPatterns(
  ref: string,
  stem: string,
  includeEmbeds: boolean,
): RegExp[] {
  const prefix = includeEmbeds ? "!?\\[\\[" : "\\[\\[";
  const escapedRef = escapeRegex(ref);
  const escapedStem = escapeRegex(stem);

  const patterns: RegExp[] = [
    // Full path reference: [[folder/filename]], [[folder/filename|alias]], [[folder/filename#heading]]
    new RegExp(
      `(${prefix})${escapedRef}(#[^\\]|]*)?(?:\\|[^\\]]*)?\\]\\]`,
      "g",
    ),
  ];

  // Stem-only reference (only if different from ref to avoid duplicate matches)
  if (escapedStem !== escapedRef) {
    patterns.push(
      new RegExp(
        `(${prefix})${escapedStem}(#[^\\]|]*)?(?:\\|[^\\]]*)?\\]\\]`,
        "g",
      ),
    );
  }

  return patterns;
}

/**
 * Get all markdown files from the vault index.
 */
export function getAllMdFiles(vault: VaultIndex): string[] {
  return vault
    .allFiles()
    .filter((f) => f.ext === ".md")
    .map((f) => f.rel);
}

export interface LinkMatch {
  link: string;
  line: number;
  context: string;
  is_embed: boolean;
}

/**
 * Find all wikilink matches in a file's content for a given target.
 */
export function findLinksInContent(
  content: string,
  ref: string,
  stem: string,
  includeEmbeds: boolean,
): LinkMatch[] {
  const patterns = buildWikiLinkPatterns(ref, stem, includeEmbeds);
  const lines = content.split("\n");
  const matches: LinkMatch[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    for (let i = 0; i < lines.length; i++) {
      let m: RegExpExecArray | null;
      const lineCopy = new RegExp(pattern.source, pattern.flags);
      while ((m = lineCopy.exec(lines[i])) !== null) {
        const key = `${i}:${m.index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push({
          link: m[0],
          line: i + 1,
          context: lines[i].trim(),
          is_embed: m[0].startsWith("!"),
        });
      }
    }
  }

  return matches;
}
