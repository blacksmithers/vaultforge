<p align="center">
  <img src="assets/vaultforge-logo.svg" alt="VaultForge" width="420" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@blacksmithers/vaultforge"><img src="https://img.shields.io/npm/v/@blacksmithers/vaultforge.svg" alt="npm version" /></a>
  <a href="https://github.com/blacksmithers/vaultforge/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" alt="node version" /></a>
  <a href="https://github.com/blacksmithers/vaultforge/actions"><img src="https://github.com/blacksmithers/vaultforge/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
</p>

<h3 align="center">The most capable MCP server for Obsidian.</h3>

<p align="center">
  <strong>27 tools</strong> · Canvas with auto-layout · BM25 smart search · Vault intelligence<br/>
  No Obsidian plugin required · Works on macOS, Linux, Windows
</p>

<p align="center">
  <a href="#canvas-tools">Canvas</a> ·
  <a href="#smart-search">Search</a> ·
  <a href="#vault-intelligence">Intelligence</a> ·
  <a href="#all-tools">All 27 Tools</a> ·
  <a href="#install">Install</a>
</p>

---

## The Problem with Every Other Obsidian MCP

I checked them all — mcp-obsidian, mcpvault, obsidian-mcp-server, obsidian-mcp-tools, obsidian-mcp-plugin. They read files. They write files. Some search. That's it.

None of them can create a visual diagram. None of them rank search results by relevance. None of them can tell an agent *"here are the 12 themes in this vault and which files belong to which."*

VaultForge does all three.

| Feature | VaultForge | mcp-obsidian | mcpvault | obsidian-mcp-server |
|---------|:-:|:-:|:-:|:-:|
| Read / Write / Delete notes | ✅ | ✅ | ✅ | ✅ |
| Full-text search | ✅ | ✅ | ✅ | ✅ |
| Edit in-place | ✅ | ❌ | ✅ | ❌ |
| Batch operations | ✅ | ❌ | ❌ | ❌ |
| Daily notes | ✅ | ❌ | ❌ | ✅ |
| Vault stats | ✅ | ❌ | ✅ | ❌ |
| **Canvas — create with auto-layout** | ✅ | ❌ | ❌ | ❌ |
| **Canvas — semantic read** | ✅ | ❌ | ❌ | ❌ |
| **Canvas — patch (add/remove/update)** | ✅ | ❌ | ❌ | ❌ |
| **Canvas — re-layout (dagre)** | ✅ | ❌ | ❌ | ❌ |
| **BM25 smart search (Orama)** | ✅ | ❌ | ❌ | ❌ |
| **Vault theme mapping (TF-IDF)** | ✅ | ❌ | ❌ | ❌ |
| **Vault reorganization engine** | ✅ | ❌ | ❌ | ❌ |
| **Regex find-and-replace (grep-sub)** | ✅ | ❌ | ❌ | ❌ |
| **Batch rename / move with link updates** | ✅ | ❌ | ❌ | ❌ |
| **Backlink analysis** | ✅ | ❌ | ❌ | ❌ |
| **Frontmatter as structured data** | ✅ | ❌ | ❌ | ❌ |
| **Directory management (delete, prune)** | ✅ | ❌ | ❌ | ❌ |
| No Obsidian plugin required | ✅ | ❌ | ✅ | ❌ |

---

## Fewer Tokens. Same Intelligence.

The other Obsidian MCPs weren't designed for AI agents — they were designed for humans who happen to use AI. Every tool returns raw, verbose data that burns through context windows. VaultForge is **AI-infrastructure**: every response is shaped to minimize token consumption while maximizing semantic density.

| Operation | Traditional MCP | VaultForge | Savings |
|---|---|---|---|
| Read a canvas | Raw JSON — coordinates, hex IDs, pixel dimensions | Semantic graph: labels + connections only | ~70-80% fewer tokens |
| Search vault | Unranked grep dump — agent reads 50 results to find 3 | BM25-ranked top results with relevance scores | ~90% fewer tokens |
| Understand vault structure | Agent reads files one by one (N calls × M tokens each) | One `vault_themes()` call returns clustered map | ~95% fewer tokens |

Tokens = API cost, context window space, and latency. Fewer tokens means faster, cheaper, smarter agents.

---

## Three Things No Other MCP Can Do

### 🎨 Canvas Tools

> The agent thinks in graphs. The tool thinks in pixels.

AI agents create, read, modify, and re-layout [JSON Canvas](https://jsoncanvas.org/) files without touching a single coordinate. The agent describes a semantic graph. VaultForge calculates all geometry using [dagre](https://github.com/dagrejs/dagre) — the same Sugiyama layout engine behind Mermaid and React Flow.

**canvas_create** — describe nodes and edges, get a fully laid-out `.canvas` file:

```
Agent sends:                              Obsidian renders:
                                          
  nodes:                                  ┌───────────┐
    - API Gateway                         │    API    │───┐
    - Auth Service                        │  Gateway  │   │
    - Database                            └───────────┘   │
    - Cache                               ┌───────────┐   │   ┌───────────┐
  edges:                                  │   Auth    │───┼──▶│ Database  │
    - API Gateway → Auth Service          │  Service  │   │   └───────────┘
    - API Gateway → Cache                 └───────────┘   │
    - Auth Service → Database                             │   ┌───────────┐
    - Cache → Database                                    └──▶│   Cache   │
  layout: { direction: "LR" }                                 └───────────┘
```

**canvas_read** — semantic graph, not raw JSON:

```
Instead of:  {"id":"231bf38f","x":-635,"y":-420,"width":250,"height":70,...}
Agent gets:  { label: "AXON", connections: ["Strategy", "AWS", "Resistance"] }
```

A typical canvas with 15 nodes returns ~200 tokens as a semantic graph vs ~2,000+ tokens as raw JSON Canvas. The agent gets the same information at 10% of the cost.

**canvas_patch** — modify with relative positioning:

```
add_nodes: [{ label: "New Module", near: "API Gateway", position: "below" }]
remove_nodes: ["Deprecated Service"]  →  cascade-removes all connected edges
```

**canvas_relayout** — fix a messy canvas with one call. Preview before committing.

---

### 🔍 Smart Search

> Not grep. Elasticsearch-grade.

[Orama](https://github.com/oramasearch/orama) BM25-ranked search with typo tolerance, stemming (26 languages), and field boosting. No ML, no API keys, no internet.

```
smart_search("stripe webhook")

  → Stripe-Webhooks.md             score: 0.92
    "...webhook endpoint configuration for handling Stripe events..."
  
  → Refactor-Prompts.md            score: 0.61
    "...refactor the Stripe integration to use webhook signatures..."

vs search_content("stripe webhook")
  → Returns EVERY file containing "stripe", unranked, no scoring
```

Unranked grep forces the agent to consume every result to find relevance. BM25 puts the answer at the top. Fewer results read = fewer tokens burned = faster, cheaper responses.

**Field boosting:** title (3×) > tags (2.5×) > headings (2×) > content (1×).

**Persistent index** at `.vaultforge/search-index.json` — survives restarts.

---

### 🧠 Vault Intelligence

> Your vault has folders. Now it has a map.

Files land where the energy of the moment puts them. Themes bleed across folders — "SpecForge" ends up in `Projetos/`, `AI/prompts/`, `Content/`, and `Empresas/`. Nobody maintains a perfect taxonomy.

**vault_themes** — scans every file, extracts distinctive terms via TF-IDF, clusters by similarity:

```json
{
  "themes": [
    {
      "label": "SpecForge Frontend",
      "key_terms": ["impl", "dashboard", "widget"],
      "files": 12,
      "folders": ["32-AI/prompts/specforge"],
      "coherence": 0.89
    },
    {
      "label": "Content Strategy",
      "files": 6,
      "folders": ["80-Content", "70-Empresas"],
      "cross_folder": true
    }
  ],
  "orphans": 5,
  "cross_folder_warnings": 3
}
```

Without this, an agent needs to `read_note` on every file individually to understand vault structure — hundreds of tool calls, thousands of tokens. One `vault_themes()` call replaces all of them.

**vault_suggest** — actionable reorganization from the atlas:

```json
{
  "suggestions": [
    { "type": "consolidate", "action": "Move Launch-Strategy.md → 80-Content/" },
    { "type": "create_moc", "action": "Create MOC-SpecForge-Frontend.md linking 12 files" },
    { "type": "archive", "action": "Move 8 stale files to 90-Archive/" }
  ]
}
```

**The full workflow:**

```
"Organize my vault"
  → vault_themes()      maps 179 files into 15 themes
  → vault_suggest()     generates 20 reorganization actions  
  → human approves      "do it, skip the archive stuff"
  → batch execution     moves files, creates MOCs
  → canvas_create()     visual theme map in Obsidian
```

The vault maps itself.

---

## All Tools

### Notes (6)
| Tool | What it does |
|------|-------------|
| `read_note` | Read content + metadata. Fuzzy path resolution. |
| `write_note` | Create or overwrite. |
| `edit_note` | In-place find and replace. Exact match, must be unique. |
| `edit_regex` | Regex find-and-replace. Single file or grep-sub across vault. Capture groups, dry run. |
| `append_note` | Append to existing, or create if missing. |
| `delete_note` | Move to `.trash` (safe) or permanent. Optional `cleanup_empty_parents` removes empty parent dirs. |

### Search & Discovery (8)
| Tool | What it does |
|------|-------------|
| `smart_search` | **BM25-ranked.** Typo tolerance, field boosting, snippets. |
| `search_reindex` | Force re-index after bulk operations. |
| `search_vault` | Fast filename/path search from in-memory index. |
| `search_content` | Full-text grep. For exact/literal matches. |
| `list_dir` | Directory listing with created/modified timestamps. Sort by name, date, or size. |
| `recent_notes` | Recently modified files. Instant from index. |
| `daily_note` | Today's daily note (or any date). |
| `vault_status` | File counts, types, index health. |

### Files (3)
| Tool | What it does |
|------|-------------|
| `batch_rename` | Rename/move files. Explicit pairs or regex patterns. Auto-updates wikilinks. Dry run default. |
| `delete_folder` | Delete empty or non-empty directories. Moves to `.trash` by default. Safety guards for `.obsidian`, `.git`, `.trash`. |
| `prune_empty_dirs` | Find and remove all empty directories. Dry run default. Bottom-up pruning handles cascading empty dirs. |

### Links (2)
| Tool | What it does |
|------|-------------|
| `update_links` | Update all wikilinks across vault after moving/renaming a file. Dry run default. |
| `backlinks` | Find all files that link to a given file. Line numbers, context, embed detection. |

### Metadata (1)
| Tool | What it does |
|------|-------------|
| `frontmatter` | Read/write/merge YAML frontmatter as structured data. No string parsing needed. |

### Canvas (4)
| Tool | What it does |
|------|-------------|
| `canvas_create` | Semantic graph → auto-laid-out `.canvas` via dagre. |
| `canvas_read` | Canvas → semantic graph (labels + connections, not coordinates). |
| `canvas_patch` | Add/remove/update with relative positioning + fuzzy matching. |
| `canvas_relayout` | Re-layout existing canvas. Preview before committing. |

### Intelligence (2)
| Tool | What it does |
|------|-------------|
| `vault_themes` | TF-IDF theme extraction + clustering. Vault atlas with cross-folder warnings. |
| `vault_suggest` | Reorganization engine: consolidate, create MOCs, archive stale, triage orphans. |

### Batch (1)
| Tool | What it does |
|------|-------------|
| `batch` | Execute multiple operations — read, write, edit, regex, rename, frontmatter, delete. Delete ops support `cleanup_empty_parents`. |

---

## Install

### Prerequisites

- A folder with Markdown files (Obsidian vault or any structure)
- One of: [Claude Desktop](https://claude.ai/download), [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [VS Code](https://code.visualstudio.com/), [Cursor](https://cursor.com/), [Windsurf](https://windsurf.com/), or any MCP-compatible client
- [Node.js](https://nodejs.org/) v22+ (not required for `.mcpb` one-click install)

**Obsidian app is not required.** VaultForge operates directly on the filesystem. If Obsidian is open, it picks up changes in real time.

### Claude Desktop (one-click)

**Windows** — [⬇ Download vaultforge.mcpb](https://github.com/blacksmithers/vaultforge/releases/latest/download/vaultforge.mcpb) — open the file, enter your vault path, done.

**macOS:**
```bash
curl -fsSL https://github.com/blacksmithers/vaultforge/releases/latest/download/vaultforge.mcpb -o /tmp/vaultforge.mcpb && open /tmp/vaultforge.mcpb
```

**Linux:**
```bash
curl -fsSL https://github.com/blacksmithers/vaultforge/releases/latest/download/vaultforge.mcpb -o /tmp/vaultforge.mcpb && xdg-open /tmp/vaultforge.mcpb
```

### Claude Code

```bash
claude mcp add vaultforge -- npx -y @blacksmithers/vaultforge /path/to/your/vault
```

### VS Code / Cursor / Windsurf

Add to your MCP settings JSON (`.vscode/mcp.json`, `.cursor/mcp.json`, or equivalent):

```json
{
  "servers": {
    "vaultforge": {
      "command": "npx",
      "args": ["-y", "@blacksmithers/vaultforge", "/path/to/your/vault"]
    }
  }
}
```

### Any MCP client

Use this universal pattern — any client that supports MCP stdio transport will work:

- **Command:** `npx`
- **Args:** `["-y", "@blacksmithers/vaultforge", "/path/to/your/vault"]`

<details>
<summary>Global install + manual Claude Desktop config</summary>

```bash
npm install -g @blacksmithers/vaultforge
```

Edit `claude_desktop_config.json`:

| OS | Config file location |
|----|---------------------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "vaultforge": {
      "command": "vaultforge",
      "args": ["/path/to/your/vault"]
    }
  }
}
```

</details>

### Verify

Ask your AI assistant: *"List the files in my vault"* — if it responds with your vault contents, you're connected.

---

## Under the Hood

### Three Engines, One Index

```
@orama/orama (BM25 index — single source of truth)
  ├── smart_search      query-driven    "find files about X"
  ├── vault_themes      corpus-driven   "what themes exist?"
  └── vault_suggest     action-driven   "how should I reorganize?"

@dagrejs/dagre (Sugiyama graph layout)
  ├── canvas_create     semantic graph → positioned canvas
  ├── canvas_patch      relative edits → absolute coordinates
  └── canvas_relayout   messy canvas → optimized layout

Wikilink engine (zero dependencies)
  ├── update_links      safe moves with automatic link repair
  ├── backlinks         impact analysis before moves/deletes
  └── batch_rename      rename + link update in one operation
```

### Dependencies

Two packages. Both MIT, TypeScript-native, zero sub-dependencies:

| Package | Purpose | Size |
|---------|---------|------|
| [`@dagrejs/dagre`](https://github.com/dagrejs/dagre) | Sugiyama graph layout | ~15KB |
| [`@orama/orama`](https://github.com/oramasearch/orama) | BM25 search engine | ~2KB core |

### Architecture

```
src/
├── tools/
│   ├── notes/                  read, write, edit, edit_regex, append, delete
│   │   └── edit-regex.ts             regex find-and-replace
│   ├── files/                  rename, move, directory management
│   │   ├── batch-rename.ts           rename/move with link updates
│   │   ├── delete-folder.ts          delete directories with safety guards
│   │   └── prune-empty-dirs.ts       find and remove empty directories
│   ├── links/                  wikilink management
│   │   ├── link-utils.ts             shared wikilink regex engine
│   │   ├── update-links.ts           fix links after moves
│   │   └── backlinks.ts              impact analysis
│   ├── metadata/               frontmatter operations
│   │   └── frontmatter.ts            read/write/merge YAML frontmatter
│   ├── search/                 search_vault, search_content, list_dir, recent, daily, status
│   │   ├── smart-search.ts           BM25 search via Orama
│   │   ├── search-reindex.ts         full/incremental re-index
│   │   ├── orama-engine.ts           Orama wrapper + persistence
│   │   └── markdown-parser.ts        strip md, extract frontmatter/headings
│   ├── intelligence/           vault analysis + reorganization
│   │   ├── vault-themes.ts           TF-IDF extraction + clustering
│   │   └── vault-suggest.ts          suggestions + batch execution
│   ├── canvas/                 JSON Canvas (jsoncanvas.org spec v1.0)
│   │   ├── canvas-create.ts
│   │   ├── canvas-read.ts
│   │   ├── canvas-patch.ts
│   │   ├── canvas-relayout.ts
│   │   ├── layout-engine.ts          dagre wrapper + edge side calc
│   │   ├── canvas-utils.ts           ID gen, text height, fuzzy match
│   │   └── types.ts
│   └── batch/                  multi-operation execution
```

---

## Roadmap

What's coming next. Ordered by priority — community input shapes the sequence.

### v0.6.0 — Vault Graph & Tags
- **`vault_graph`** — Export the vault's link graph as a JSON adjacency list. Nodes = files, edges = wikilinks. Enables agents to reason about knowledge structure, find clusters, detect orphans, and identify bridge notes. Output compatible with D3, Cytoscape, or canvas_create for visual rendering.
- **`tag_search`** — Search by YAML frontmatter tags, separate from content search. Filter by tag combinations (`tag:draft AND tag:specforge`). Returns files with matching tags plus their frontmatter metadata.
- **`diff_note`** — Compare two notes (or two versions of the same note) and return a structured diff. Useful for agents reviewing changes, merging edits, or auditing vault history.

### v0.7.0 — Template Engine & Smart Create
- **`template_create`** — Create notes from templates with variable substitution (`{{date}}`, `{{title}}`, `{{tags}}`). Supports custom template folders. The agent describes intent, the tool handles boilerplate.
- **`smart_create`** — AI-aware note creation. Analyzes vault themes and suggests optimal location, tags, and links for new notes. "Write about X" → creates the note in the right folder with relevant backlinks.

### v0.8.0 — Performance at Scale
- Large vault optimization (10k+ files) — incremental indexing, lazy loading, memory-mapped file access
- Parallel batch operations where order independence allows
- Index compression for faster startup on large vaults
- Benchmark suite with reproducible performance targets

### v1.0.0 — Stability & Ecosystem
- Comprehensive test suite with >90% coverage
- Stable API — no breaking changes without major version bump
- Plugin ecosystem hooks — allow community extensions
- Published to MCP registry
- Obsidian community plugin (optional companion for enhanced integration)

### Community-Driven
Open an issue tagged `roadmap` to propose features. The most-requested items move up the queue. This is an open forge — the community shapes the steel.

---

## The Forge is Open

VaultForge is the first open-source tool from the **Blacksmithers** — a community of builders who forge tools that build things.

We don't wrap APIs and call it innovation. We build real engines — BM25 search, graph layout, TF-IDF clustering — because the tools AI agents use should be as rigorous as the agents themselves.

**If that resonates, you're already one of us.**

### Contributing

Open an issue first to discuss changes. PRs welcome — especially for:

- Semantic similarity search (embedding-based, complementing BM25)
- Canvas layout algorithms beyond Sugiyama (force-directed, circular)
- Performance improvements for large vaults (10k+ files)
- Windows-specific edge cases and path handling
- New language stemmers for smart search

### Community

- 🔨 [blacksmithers.dev](https://blacksmithers.dev) — The movement
- 🐦 [@gabgforge](https://x.com/gabgforge) — Engineer · Founder · Blacksmither
- 💬 [GitHub Discussions](https://github.com/orgs/blacksmithers/discussions) — Ideas, feedback, show & tell

### License

[MIT](LICENSE) — [Solutions Forge LTDA](https://solutionsforge.tech)

---

<p align="center">
  <strong>Stop automating spreadsheets. Start forging.</strong>
</p>
