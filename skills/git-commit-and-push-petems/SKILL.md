---
name: git-commit-and-push-petems
description: Commit and push with Peter's conventional commit format (50-char titles, * bullet details, imperative mood)
license: MIT
allowed-tools:
  - Bash
---

# Committing and pushing changes with git

When the user asks you to commit (and optionally push) changes, follow these steps carefully.

## Git Safety Protocol

- NEVER update the git config
- NEVER run destructive git commands (push --force, reset --hard, checkout ., restore ., clean -f, branch -D) unless the user explicitly requests these actions
- NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it
- NEVER force push to main/master — warn the user if they request it
- NEVER commit directly to the trunk branch (master or main). Always create a feature branch first. Detect the trunk branch using the method described in Step 2 below.
- CRITICAL: Always create NEW commits rather than amending, unless the user explicitly requests a git amend. When a pre-commit hook fails, the commit did NOT happen — so --amend would modify the PREVIOUS commit. Instead, after hook failure, fix the issue, re-stage, and create a NEW commit
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
  If that returns nothing (no remote HEAD configured), fall back to checking which of `master` or `main` exists as a local branch. Prefer `master` if both exist.
- `git branch --show-current` — get the current branch name.

### 2. Ensure you are on a feature branch

Compare the current branch against the detected trunk branch.

- **If on the detected trunk branch**: you MUST create a feature branch before committing.
  - Derive the branch name from the planned commit type and a short slug of the description, e.g. `feat/add-oauth-login`, `fix/null-pointer-in-parser`, `refactor/extract-auth-middleware`.
  - Run `git checkout -b <branch-name>`.
  - Inform the user: "Created branch `<branch-name>` to avoid committing directly to `<trunk>`."
- **If already on a feature branch**: proceed to the next step.

### 3. Draft the commit message

Analyze all staged changes (both previously staged and newly added) and draft a commit message following **Conventional Commits** format with these rules:

#### Title line
- Format: `<type>(<scope>): <description>`
- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`
- **Maximum 50 characters** for the entire title line
- Use **imperative mood** ("add", "fix", "update" — not "added", "fixes", "updated")
- Do NOT end with a period
- Scope is optional but encouraged

#### Body (details)
- Separate from title with a blank line
- Use `*` bullet points to describe what changed and why
- Each bullet line should be ≤ 72 characters
- Focus on the "why" rather than the "what"

#### Footer
- Reference GitHub issues/PRs using standard shorthand: `#123`
- Use `Closes #123` or `Fixes #123` when the commit resolves an issue

#### Example

```
feat(auth): add OAuth2 login support

* Add OAuth2 provider configuration
* Update login controller for new flow
* Add token refresh middleware

Closes #42
```

#### What NOT to commit
- Files that likely contain secrets (`.env`, `credentials.json`, etc.) — warn the user if they specifically request to commit those files

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
