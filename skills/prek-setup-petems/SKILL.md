---
name: prek-setup-petems
description: Set up prek git hooks with sensible defaults and language-specific linters
license: MIT
allowed-tools:
  - Bash
  - Glob
---

# Set up prek git hooks

When the user asks you to set up prek (or pre-commit hooks using prek), follow these steps carefully.

## Step 1: Check for existing config

Look for existing hook configuration files:

- `prek.toml`
- `.pre-commit-config.yaml`

If either exists, ask the user whether to **overwrite**, **merge** with the new config, or **leave it** unchanged. Do not proceed until the user confirms.
If the user chooses **leave it unchanged**, stop the workflow and report that no changes were made.

## Step 2: Ensure prek is installed

Check if prek is available:

```bash
command -v prek
```

If not found, ask the user which installation method they prefer:

- `brew install prek` (macOS/Linuxbrew)
- `cargo install prek` (Rust toolchain)
- `pipx install prek` (Python)

After installation, verify with:

```bash
prek --version
```

## Step 3: Detect project languages

Use Glob to check for marker files that indicate which languages the project uses:

| Marker files | Language |
|---|---|
| `pyproject.toml`, `setup.py`, `requirements.txt`, `Pipfile` | Python |
| `package.json` | JavaScript/TypeScript |
| `go.mod` | Go |
| `Cargo.toml` | Rust |
| `Gemfile`, `*.gemspec` | Ruby |
| `**/*.tf` | Terraform |
| `Package.swift`, `*.xcodeproj` | Swift |
| `pom.xml`, `build.gradle`, `build.gradle.kts` | Java/Kotlin |
| `**/*.sh` | Shell |

Report detected languages to the user before continuing.

## Step 4: Build `prek.toml`

Build a `prek.toml` config file using the native TOML format (recommended by prek).

### Universal hooks (always included)

```toml
[[repos]]
repo = "https://github.com/pre-commit/pre-commit-hooks"
rev = "v6.0.0"
hooks = [
  { id = "trailing-whitespace" },
  { id = "end-of-file-fixer" },
  { id = "check-yaml" },
  { id = "check-json" },
  { id = "check-merge-conflict" },
  { id = "detect-private-key" },
  { id = "check-added-large-files" },
]
```

### Language-specific hooks

Only include sections for detected languages:

**Python:**
```toml
[[repos]]
repo = "https://github.com/astral-sh/ruff-pre-commit"
rev = "v0.11.4"
hooks = [
  { id = "ruff", args = ["--fix"] },
  { id = "ruff-format" },
]
```

**JavaScript/TypeScript:**
```toml
[[repos]]
repo = "https://github.com/pre-commit/mirrors-prettier"
rev = "v3.8.1"
hooks = [
  { id = "prettier" },
]
```

**Go:**
```toml
[[repos]]
repo = "https://github.com/golangci/golangci-lint"
rev = "v2.1.0"
hooks = [
  { id = "golangci-lint" },
]
```

**Rust:**
```toml
[[repos]]
repo = "local"
hooks = [
  { id = "cargo-fmt", name = "cargo fmt", entry = "cargo fmt --", language = "system", types = ["rust"] },
  { id = "cargo-clippy", name = "cargo clippy", entry = "cargo clippy --all-targets --all-features -- -D warnings", language = "system", types = ["rust"], pass_filenames = false },
]
```

**Ruby:**
```toml
[[repos]]
repo = "https://github.com/rubocop/rubocop"
rev = "v1.85.1"
hooks = [
  { id = "rubocop" },
]
```

**Terraform:**
```toml
[[repos]]
repo = "https://github.com/antonbabenko/pre-commit-terraform"
rev = "v1.105.0"
hooks = [
  { id = "terraform_fmt" },
  { id = "terraform_validate" },
  { id = "terraform_tflint" },
]
```

**Swift:**
```toml
[[repos]]
repo = "https://github.com/nicklockwood/SwiftFormat"
rev = "0.55.6"
hooks = [
  { id = "swiftformat" },
]

[[repos]]
repo = "https://github.com/realm/SwiftLint"
rev = "0.58.2"
hooks = [
  { id = "swiftlint" },
]
```

**Shell:**
```toml
[[repos]]
repo = "https://github.com/shellcheck-py/shellcheck-py"
rev = "v0.10.0.1"
hooks = [
  { id = "shellcheck" },
]
```

**Java/Kotlin:**
```toml
[[repos]]
repo = "https://github.com/macisamuele/language-formatters-pre-commit-hooks"
rev = "v2.14.0"
hooks = [
  { id = "pretty-format-java", args = ["--autofix"] },
  { id = "pretty-format-kotlin", args = ["--autofix"] },
]
```

### Present config before writing

Show the assembled `prek.toml` to the user and ask for confirmation before writing it. Make any requested adjustments first.

## Step 5: Install hooks

Run prek install, handling potential global hooksPath conflicts:

```bash
git -c core.hooksPath=.git/hooks prek install
```

## Step 6: Run initial check

Run prek across all files to catch and auto-fix issues:

```bash
prek run --all-files
```

If there are auto-fixable issues, let prek fix them and re-run up to 3 times. If issues still remain (or output does not converge), stop and report remaining failures for manual intervention.

## Step 7: Stage config (do NOT commit)

Stage only the new `prek.toml` and files modified by this prek run (do not stage unrelated pre-existing changes), then do **not** commit.

Tell the user:
- Setup is complete
- Files are staged and ready to commit when they are satisfied
- They can run `prek autoupdate` later to pin hooks to the latest revisions
