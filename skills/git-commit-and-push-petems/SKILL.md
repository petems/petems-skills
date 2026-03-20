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

### 2. Draft the commit message

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

### 3. Stage and commit

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

### 4. Push (if requested)

If the user asked to push:

- Check if the current branch tracks a remote branch: `git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null`
- If no upstream is set, push with `-u`: `git push -u origin $(git branch --show-current)`
- Otherwise: `git push`
- Report the result to the user.

### 5. If pre-commit hook fails

- Read the hook output to understand what failed.
- Fix the issue (formatting, linting, etc.).
- Re-stage the fixed files.
- Create a **NEW** commit (do NOT use `--amend`).
