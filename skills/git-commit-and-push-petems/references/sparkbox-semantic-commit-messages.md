# Semantic Commit Messages (Sparkbox)

> Source: <https://sparkbox.com/foundry/semantic_commit_messages>

## Overview

This Sparkbox article advocates for prefixing every commit message with a semantic type, turning informal commit logs into structured, machine-readable metadata. The goal is to make project history scannable, filterable, and suitable for automated changelog generation.

## Commit Message Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

## Commit Types

| Type       | Purpose                                                    |
|------------|------------------------------------------------------------|
| `feat`     | Introduces new functionality                               |
| `fix`      | Resolves a bug or defect                                   |
| `docs`     | Documentation-only changes                                 |
| `style`    | Formatting, whitespace, semicolons (no logic changes)      |
| `refactor` | Restructures code without changing external behavior       |
| `perf`     | Improves performance                                       |
| `test`     | Adds or updates tests                                      |
| `chore`    | Build process, dependency updates, tooling                 |

## Key Benefits

1. **Automated changelogs** -- commit types let tooling categorize changes automatically.
2. **SemVer alignment** -- `feat` maps to MINOR, `fix` maps to PATCH, making version bumps deterministic.
3. **Readable history** -- scanning a log of prefixed messages instantly reveals the nature of each change.
4. **Easy filtering** -- `git log --grep="^feat"` surfaces only feature work.
5. **Better context** -- forces authors to classify their change, which improves clarity for future readers.

## Core Reasoning

By categorizing every commit consistently, teams create a narrative that both humans and tools can interpret. This reduces manual version management overhead and makes each contribution's intent explicit at a glance.
