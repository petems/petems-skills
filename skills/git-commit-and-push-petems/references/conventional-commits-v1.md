# Conventional Commits v1.0.0

> Source: <https://www.conventionalcommits.org/en/v1.0.0/>

## Overview

Conventional Commits is a formal specification for structuring commit messages in a way that is both human-readable and machine-parseable. It layers a set of rules on top of commit messages that map directly to Semantic Versioning (SemVer).

## Commit Message Format

```text
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

## Core Types

The spec mandates two primary types:

- **feat** -- introduces new functionality (correlates to a SemVer MINOR bump)
- **fix** -- patches a bug (correlates to a SemVer PATCH bump)

Additional types such as `docs`, `style`, `refactor`, `perf`, `test`, `build`, `chore`, and `ci` are permitted but not required by the spec itself.

## Breaking Changes

Breaking changes trigger a SemVer MAJOR version bump. They can be signalled in two ways:

1. Appending `!` after the type/scope, e.g. `feat!: remove deprecated endpoint`
2. Including a `BREAKING CHANGE:` token in the commit footer with a description

Both can be used together.

## Key Rules

- The type must be followed by a colon and a space (scope is optional and goes in parentheses).
- The description immediately follows the colon+space prefix.
- The body begins one blank line after the description.
- Footers use a `token: value` or `token #value` format, with dashes replacing spaces in multi-word tokens.
- `BREAKING CHANGE` must be uppercase; `BREAKING-CHANGE` is treated as synonymous.
- All other footer tokens are case-insensitive.

## Why It Matters

- Enables automated CHANGELOG generation.
- Allows tooling to determine the correct SemVer bump automatically.
- Communicates the nature of changes clearly to teammates and consumers.
- Can trigger CI/CD build and publish workflows based on commit type.
- Provides a structured, searchable history for contributors.
