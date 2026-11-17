# CLAUDE.md

## Project

Generalist Claude Code skills collection by petems. See `README.md` for the full list.

## Structure

```text
skills/<name>/SKILL.md           One directory per skill
skills/<name>/<tool>/            Bundled CLI for browser skills (uv project)
packages/skill-browser/          Shared Patchright plumbing for those CLIs
pyproject.toml                   uv workspace root (dev only, no package)
.claude-plugin/                  Plugin manifest + marketplace catalog
```

## Tooling

- This repo uses **prek** for pre-commit hooks (`prek.toml` at repo root).
- Python CLIs use **uv**. The repo root is a uv workspace, so run tests from
  there: `uv run --package <tool> --group dev pytest <path>`.

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

## Browser-based skills

Any skill that logs in to a website and fetches something (bills, invoices,
statements) is built as a **bundled Patchright CLI on `packages/skill-browser`**,
not as a script of `mcp__chrome-devtools__*` calls. `three-bill`,
`hyperoptic-bill` and `peloton-invoice` are the reference implementations, and
`packages/skill-browser/README.md` has the step-by-step guide.

- **Layout.** `skills/<name>/<tool>/` is a uv project with a `contract.py` of
  pure, unit-tested site facts (URLs, response shapes, identifier formats), a
  site module that only moves data between the browser and `contract.py`, and
  `login.py` / `cli.py` built from `skill_browser.login` and
  `skill_browser.cli`. Add the directory to the root `pyproject.toml`
  workspace members.
- **Dependency.** Depend on `skill-browser` by git URL pinned to a
  `skill-browser-v*` tag, so the skill still installs when copied on its own.
  When `packages/skill-browser` changes, bump its version and push a new tag
  after merge (see its README).
- **One profile per tool** at `~/.<tool>/profile`, guarded by the shared
  `flock` lease. Never point a tool at the user's everyday Chrome, never use a
  remote-debugging port, and never delete lock files.
- **The human logs in.** The skill asks the user to run `! <tool> login` and
  never types, asks for, or handles credentials.
- **Secrets stay in the CLI.** Tokens and cookies never reach stdout, stderr,
  diagnostics or the model's context. Output is one JSON document on stdout;
  errors are JSON on stderr with the shared exit codes (3 login, 4 busy, 5
  contract changed, 6 not found, 7 bad PDF, 8 shutdown unconfirmed, 9 API or
  network, 10 output exists).
- **SKILL.md** allows only `Bash` and `Read`, runs the CLI, branches on exit
  codes, and verifies the saved file itself. The CLI refuses to overwrite a
  file unless the user agrees and the skill passes `--overwrite`.
- **Tests** cover `contract.py` with unit tests and the whole flow against a
  local fake of the site (`browser` marker). Tests never load the real site.
- **Chrome DevTools MCP is for investigation only**: exploring a new site
  before writing its `contract.py`, or working out what changed when a CLI
  exits 5. Write what you learn into the skill's `references/` and
  `contract.py`; do not ship a skill whose runtime path is MCP calls.

If an investigation MCP call fails with "The browser is already running",
check `readlink ~/.cache/chrome-devtools-mcp/chrome-profile/SingletonLock`.
The target is `HOSTNAME-PID`; kill that PID only if it is an old MCP Chrome
(not the user's regular Chrome), then retry.
