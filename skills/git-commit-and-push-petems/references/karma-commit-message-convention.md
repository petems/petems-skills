# Karma Git Commit Message Convention

> Source: <https://karma-runner.github.io/1.0/dev/git-commit-msg.html>

## Overview

The Karma runner project defined one of the earliest widely-adopted commit message conventions. Its primary goals are enabling automatic changelog generation and making git history easy to navigate with tools like `git log --oneline`.

## Commit Message Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

## Header Rules

- The entire first line must be at most **70 characters**.
- Both `type` and `scope` must be **lowercase**.
- A blank line separates the header from the body; subsequent lines wrap at 80 characters.

## Allowed Types

| Type       | Purpose                                       |
|------------|-----------------------------------------------|
| `feat`     | New user-facing feature                       |
| `fix`      | Bug fix for end users                         |
| `docs`     | Documentation updates                         |
| `style`    | Formatting only (no code logic changes)       |
| `refactor` | Production code restructuring                 |
| `test`     | Adding or refactoring tests                   |
| `chore`    | Build scripts, tooling, maintenance           |

## Scope

The scope narrows what part of the codebase is affected. Examples from Karma: `init`, `runner`, `watcher`, `config`, `web-server`, `proxy`. The scope (and its parentheses) can be omitted when the change is global or hard to categorize.

## Subject

- Use **imperative, present tense**: "change", not "changed" or "changes".
- Do not capitalize the first letter.
- Do not end with a period.

## Body

- Also uses imperative present tense.
- Should explain the **motivation** for the change and contrast the new behavior with the previous behavior.

## Footer

- **Closing issues**: `Closes #234` or `Closes #123, #245, #992`.
- **Breaking changes**: Start with `BREAKING CHANGE:` followed by a description of the change, a justification, and migration instructions.

## Example

```
fix(middleware): ensure Range headers adhere more closely to RFC 2616

Add one new dependency to ensure Range headers are correctly parsed.
Previous behavior returned a 200 for unsatisfiable ranges; now
returns 416 as specified by the RFC.

Fixes #2310
```

## Historical Significance

This convention predates and directly influenced both the Conventional Commits specification and the Angular commit message guidelines. Many of the rules in those later specs (type prefixes, scope, imperative mood, BREAKING CHANGE footer) originate here.
