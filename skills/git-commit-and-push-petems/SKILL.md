---
name: git-commit-and-push-petems
description: Commit and push with Peter's conventional commit format (50-char titles, * bullet details, imperative mood)
license: MIT
allowed-tools:
  - Bash
---

# Committing and pushing changes with git

When the user asks you to commit (and optionally push) changes, follow these steps carefully.

This skill builds on established commit message conventions with petems-specific preferences layered on top. For background on why each rule exists, see the reference material below.

## Reference material

Read these files when you need deeper context on the reasoning behind a rule:

- For the Conventional Commits v1 spec: read `${CLAUDE_SKILL_DIR}/references/conventional-commits-v1.md`
- For the Conventional Branch spec (branch-naming rules): read `${CLAUDE_SKILL_DIR}/references/conventional-branch.md`
- For the Karma runner commit convention (the original inspiration): read `${CLAUDE_SKILL_DIR}/references/karma-commit-message-convention.md`
- For the Sparkbox semantic commit style: read `${CLAUDE_SKILL_DIR}/references/sparkbox-semantic-commit-messages.md`
- For petems-specific preferences that go beyond the specs: read `${CLAUDE_SKILL_DIR}/references/petems-preferences.md`

## Git Safety Protocol

- NEVER update the git config
- NEVER run destructive git commands (push --force, reset --hard, checkout ., restore ., clean -f, branch -D) unless the user explicitly requests these actions
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it
- NEVER force push to main/master, warn the user if they request it
- NEVER commit directly to the trunk branch (`master`, `main`, or `develop`). Always create a feature branch first. Detect the trunk branch using the method described in Step 2 below.
- CRITICAL: Always create NEW commits rather than amending, unless the user explicitly requests a git amend. When a pre-commit hook fails, the commit did NOT happen, so --amend would modify the PREVIOUS commit. Instead, after hook failure, fix the issue, re-stage, and create a NEW commit
- When staging files, prefer adding specific files by name rather than using `git add -A` or `git add .`, which can accidentally include sensitive files (.env, credentials) or large binaries
- NEVER commit changes unless the user explicitly asks you to
- DO NOT push to the remote repository unless the user explicitly asks you to do so

## Steps

### 1. Gather context

Run the following bash commands in parallel to understand the current state:

- `git status` — see all untracked and modified files. IMPORTANT: Never use the `-uall` flag as it can cause memory issues on large repos.
- `git diff` and `git diff --staged` — see both staged and unstaged changes.
- `git log --oneline -10` — see recent commit messages for style reference.
- Detect the trunk branch name:
  ```bash
  git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'
  ```
  If that returns nothing (no remote HEAD configured), fall back to checking which of `master`, `main`, or `develop` exists as a local branch. Prefer `master` if both `master` and `main` exist. Per the Conventional Branch spec, treat `master`, `main`, and `develop` collectively as long-lived "trunk-like" branches that should not receive direct commits.
- `git branch --show-current` — get the current branch name.

### 2. Ensure you are on a properly named feature branch

Compare the current branch against the detected trunk branch, then validate the branch name. There are three cases:

- **If on the detected trunk branch** (`master`, `main`, or `develop`): you MUST create a feature branch before committing.
  - Derive the branch name using the naming convention below.
  - Run `git checkout -b <branch-name>`.
  - Inform the user: "Created branch `<branch-name>` to avoid committing directly to `<trunk>`."
- **If on a non-trunk branch whose name does NOT match the validation pattern below**: do NOT silently commit on the non-conforming branch. Instead:
  - Derive a conformant name using the naming convention below, based on the staged/unstaged changes you saw in Step 1.
  - Run `git checkout -b <new-name>` to create the new branch off the current HEAD. This preserves any commits already made on the old branch, since `git checkout -b` only creates a new ref at the same commit and leaves the old ref in place.
  - Inform the user: "Current branch `<old>` does not follow the convention. Created `<new>` off `<old>`; the old branch ref is left in place so you can clean it up later."
- **If on a non-trunk branch whose name matches the validation pattern**: proceed to the next step.

#### Branch name validation pattern

A branch name is valid if it matches this pattern (extended POSIX regex, usable with `grep -E`):

```regex
^(feat|feature|fix|bugfix|hotfix|release|docs|style|refactor|perf|test|build|ci|chore|revert)\/[a-z0-9]+([.\/-][a-z0-9]+)*$
```

In prose:

- The name must start with one of the allowed type prefixes followed by `/`.
- The description after the `/` is one or more "runs" of `[a-z0-9]` separated by a single hyphen (`-`), dot (`.`), or forward slash (`/`).
- Uppercase letters and underscores (`_`) are not allowed anywhere.
- Consecutive separators (`--`, `..`, `//`) are not allowed.
- The description cannot start or end with a separator (those positions must be `[a-z0-9]`).
- Single-character descriptions are valid (e.g. `fix/x`).

To validate the current branch from bash:

```bash
git branch --show-current | grep -Eq '^(feat|feature|fix|bugfix|hotfix|release|docs|style|refactor|perf|test|build|ci|chore|revert)\/[a-z0-9]+([.\/-][a-z0-9]+)*$'
```

This pattern is the union of the petems commit-type list and the Conventional Branch canonical types. See `${CLAUDE_SKILL_DIR}/references/conventional-branch.md` for the upstream spec.

#### Branch naming convention

When creating a new branch, use the following pattern:

```text
<type>/#<issueNumber>-<alias>
  |         |           |
  |         |           +---> Summary in kebab-case.
  |         +--------------> Reference to the issue/ticket.
  +------------------------> Type: feat, feature, fix, bugfix, hotfix,
                              release, docs, style, refactor, perf, test,
                              build, ci, chore, or revert.
```

When there is no issue number, use a short slug, e.g. `feat/add-oauth-login`, `fix/null-pointer-in-parser`, `refactor/extract-auth-middleware`.

| Prefix               | Purpose                                      |
|----------------------|----------------------------------------------|
| `feat` or `feature`  | New feature                                  |
| `fix` or `bugfix`    | Bug fix                                      |
| `hotfix`             | Urgent production fix                        |
| `release`            | Release-preparation branch (e.g. `release/v1.2.0`) |
| `docs`               | Documentation only                           |
| `style`              | Formatting, missing semicolons, etc.         |
| `refactor`           | Code change that neither fixes nor adds      |
| `perf`               | Performance improvement                      |
| `test`               | Adding or updating tests                     |
| `build`              | Build system or external dependency changes  |
| `ci`                 | CI configuration changes                     |
| `chore`              | Maintenance (deps, tooling, etc.)            |
| `revert`             | Revert a prior commit                        |

> References: <https://conventional-branch.github.io/>, <https://gist.github.com/seunggabi/87f8c722d35cd07deb3f649d45a31082>

### 3. Draft the commit message

Analyze all staged changes (both previously staged and newly added) and draft a commit message following **Conventional Commits** format with petems preferences applied.

> The base format comes from the Conventional Commits spec (`${CLAUDE_SKILL_DIR}/references/conventional-commits-v1.md`),
> with type prefixes drawn from the Karma convention (`${CLAUDE_SKILL_DIR}/references/karma-commit-message-convention.md`).
> Where this skill diverges from those specs, see petems preferences (`${CLAUDE_SKILL_DIR}/references/petems-preferences.md`).

#### Title line

- Format: `<type>(<scope>): <description>`
- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`
- **Maximum 50 characters** for the entire title line (stricter than Karma's 70; follows the classic 50/72 rule)
- Use **imperative mood** ("add", "fix", "update", not "added", "fixes", "updated")
- Do NOT end with a period
- Scope is optional but encouraged

#### Body (details)

- Separate from title with a blank line
- Use `*` bullet points to describe what changed and why (petems preference; the specs do not mandate a bullet character)
- Each bullet line should be ≤ 72 characters (petems preference; Karma uses 80)
- Focus on the "why" rather than the "what"
- Unless the change is trivial, include links to relevant references (issues, PRs, docs, design docs, etc.)

#### Footer

- Reference GitHub issues/PRs using standard shorthand: `#123`
- Use `Closes #123` or `Fixes #123` when the commit resolves an issue

#### Example

```text
feat(auth): add OAuth2 login support

* Add OAuth2 provider configuration
* Update login controller for new flow
* Add token refresh middleware

Closes #42
```

#### What NOT to commit

- Files that likely contain secrets (`.env`, `credentials.json`, etc.), warn the user if they specifically request to commit those files

### 4. Stage and commit

- Add relevant untracked files to the staging area by name.
- Create the commit. ALWAYS pass the commit message via a HEREDOC for correct formatting:

```bash
git commit -m "$(cat <<'EOF'
<type>(<scope>): <description>

* Detail line one
* Detail line two

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

- Run `git status` after the commit completes to verify success.

### 5. Push (if requested)

If the user asked to push:

- Check if the current branch tracks a remote branch: `git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null`
- If no upstream is set, push with `-u`: `git push -u origin $(git branch --show-current)`
- Otherwise: `git push`
- Report the result to the user.
- If a new feature branch was created in Step 2, suggest the user create a pull request (but do NOT create one automatically).

### 6. If pre-commit hook fails

- Read the hook output to understand what failed.
- Fix the issue (formatting, linting, etc.).
- Re-stage the fixed files.
- Create a **NEW** commit (do NOT use `--amend`).
