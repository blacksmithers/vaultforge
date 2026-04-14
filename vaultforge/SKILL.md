---
name: obsidian-vaultforge
description: >
  Manage your Obsidian Vault via CLI. Powerfully read, search, and refactor notes using natural language commands.
metadata:
  version: 1.0.3
  author: blacksmithers
references:
  - references/commands.md
---

# Obsidian VaultForge Agent Skill (Antigravity)

You are an AI Agent (Antigravity) with access to the user's Obsidian Vault via the **VaultForge CLI** `vault-cli`. 

**CRITICAL RULES:**
1. Prefix: `vault-cli <command_name>`.
2. Args: Valid JSON object in single quotes `'`.
3. Example: `vault-cli read_note '{"path": "Idea.md"}'`

Refer to `references/commands.md` for full API documentation.