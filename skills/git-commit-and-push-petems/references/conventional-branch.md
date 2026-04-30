# Conventional Branch

> Source: <https://conventional-branch.github.io/>

## Overview

Conventional Branch is a lightweight specification for naming Git branches in
a structured, machine-parseable way. It is the branch-name analogue of
Conventional Commits: a fixed set of type prefixes plus strict character
rules so that branch names are readable, sortable, and easy to validate in
CI.

## Format

```text
<type>/<description>
```

## Canonical Types

| Prefix       | Purpose                                              |
|--------------|------------------------------------------------------|
| `feature` or `feat` | New feature work                              |
| `bugfix` or `fix`   | Bug fix for a regular (non-urgent) issue      |
| `hotfix`     | Urgent production fix                                |
| `release`    | Release-preparation branch (e.g. `release/v1.2.0`)   |
| `chore`      | Non-code maintenance (deps, tooling, docs)           |

## Naming Rules

- **Lowercase only** (no uppercase letters anywhere).
- Allowed characters are `[a-z0-9]`, hyphens (`-`), dots (`.`), and forward
  slashes (`/`). **No underscores.**
- No consecutive hyphens (`--`) or dots (`..`).
- The description must not start or end with a hyphen or dot.

## Long-lived / Exempt Branches

`main`, `master`, and `develop` are exempt from the prefix rule because they
are long-lived branches rather than topical work branches.

## Valid Examples

```bash
git checkout -b feature/add-login-page
git checkout -b feat/user-authentication
git checkout -b feature/issue-123-payment-integration
git checkout -b bugfix/fix-header-alignment
git checkout -b fix/memory-leak-in-parser
git checkout -b hotfix/security-patch-cve-2024
git checkout -b release/v1.2.0
git checkout -b release/v2.0.0-beta.1
git checkout -b chore/update-dependencies
```

## Invalid Examples

```bash
# Uppercase not allowed
git checkout -b feature/New-Login

# Underscores not allowed
git checkout -b fix_header_bug

# Leading hyphen in description not allowed
git checkout -b feature/-login

# Trailing dot not allowed
git checkout -b release/v1.2.0.

# Consecutive hyphens not allowed
git checkout -b feature/new--login
```

## Why It Matters

- Enables CI/CD jobs to gate on prefix (e.g. only `release/*` deploys to
  staging).
- Makes `git branch --list` output self-organizing.
- Reduces back-and-forth in code review when teammates disagree about how
  to name short-lived branches.
- Makes automated branch validation (pre-receive hooks, branch-protection
  rules) trivial.
