# CLAUDE.md

## Project

Generalist Claude Code skills collection by petems. See `README.md` for the full list.

## Structure

```text
skills/<name>/SKILL.md           One directory per skill
.claude-plugin/                  Plugin manifest + marketplace catalog
```

## Tooling

- This repo uses **prek** for pre-commit hooks (`prek.toml` at repo root).

## Rules

- Each skill lives in `skills/<name>/SKILL.md` with YAML frontmatter (name, description, license, allowed-tools).
- Skills are named with a `-petems` suffix to indicate they reflect Peter's preferences.
- **No em dashes**. Use commas, periods, or parentheses instead.
- **AI slop checklist for writing skills.** Any skill that generates prose, text,
  or writing (blog posts, talks, slides, speaker notes, documentation, etc.) must
  include `references/ai-slop-checklist.md` in its references folder and reference
  it in the skill's review/iterate step. Adapt the format-specific notes to match
  the skill's output type. See `skills/blog-post-writer-petems/references/` or
  `skills/conference-talk-builder-petems/references/` for examples.

## Chrome DevTools MCP

Skills that use `mcp__chrome-devtools__*` tools require an MCP-managed Chrome instance. If a tool call fails with "The browser is already running", check for a stale lock file and orphaned Chrome process:

```bash
# Check for stale lock
ls -la ~/.cache/chrome-devtools-mcp/chrome-profile/SingletonLock

# Find the PID from the symlink target (e.g. HOSTNAME-PID)
readlink ~/.cache/chrome-devtools-mcp/chrome-profile/SingletonLock

# If the process is an old MCP Chrome (not regular Chrome), kill it
kill <PID>
```

After clearing the stale process, retry the MCP tool call.
