---
name: slidegauge-check-petems
description: >-
  Analyze and improve Marp markdown presentations using SlideGauge quality
  checks. Use when working with Marp slides (.md files with marp: true
  frontmatter), or when the user asks to check, analyze, validate, or
  improve slide quality. Also trigger when the user mentions SlideGauge
  or presentation quality issues.
license: MIT
allowed-tools:
  - Bash
  - Read
  - Edit
---

# Marp Slide Quality Analyzer (SlideGauge)

Analyze Marp markdown presentations with SlideGauge and fix quality issues.

## When to use this skill

- User is working on a Marp presentation (`.md` file with `marp: true` frontmatter)
- User asks to check, analyze, validate, or improve slide quality
- User mentions SlideGauge or slide quality issues
- User wants to fix specific slide problems (too many bullets, long content, etc.)

## Workflow

1. **Analyze**: Run SlideGauge to get baseline scores
2. **Prioritize**: Focus on slides scoring < 70 first, then < 80
3. **Fix**: Apply fixes based on diagnostics (see fix patterns below)
4. **Validate**: Re-run SlideGauge to confirm improvements
5. **Iterate**: Repeat until all slides pass or user is satisfied

## Running SlideGauge

### Quick overview (text output)

```bash
uvx --from git+https://github.com/nibzard/slidegauge slidegauge <path-to-presentation.md> --text
```

### Detailed diagnostics (JSON output)

```bash
uvx --from git+https://github.com/nibzard/slidegauge slidegauge <path-to-presentation.md> --json | jq '.slides[] | select(.score < 80)'
```

Note: The first run may take a few seconds to fetch the package. Subsequent runs are cached.

## Scoring

Each slide starts at 100 points. Deductions are applied per rule violation.

| Score | Quality   | Action               |
| ----- | --------- | -------------------- |
| 90+   | Excellent | Leave as-is          |
| 80-89 | Good      | Suggest improvements |
| 70-79 | Passing   | Recommend fixing     |
| < 70  | Failing   | Must fix             |

## Rules Quick Reference

| Rule | Severity | Deduction | Threshold | Quick Fix |
| ---- | -------- | --------- | --------- | --------- |
| `title/required` | error | -30 | Must have heading | Add `#` heading |
| `accessibility/alt_required` | error | -20 | Images need alt text | Add `![alt text](path)` |
| `color/low_contrast` | error | -20 | >= 4.5:1 ratio (WCAG AA) | Increase contrast |
| `content/too_long` | warning | -15 | <= 350 chars (450 for exercises) | Trim or split slide |
| `bullets/too_many` | warning | -10 | <= 6 bullets | Split slide or merge bullets |
| `lines/too_many` | warning | -10 | <= 15 lines | Condense or split |
| `title/too_long` | warning | -10 | <= 35 chars | Shorten title |
| `color/too_many` | warning | -10 | <= 6 unique colors | Reduce palette |
| `code/too_long` | warning | -8 | <= 10 lines (5 for complex) | Simplify or split |
| `content/too_short` | info | -5 | >= 50 chars | Add context |
| `links/bare_urls` | info | -5 | No bare URLs | Use `[text](url)` |

## Fix Patterns

### Too many bullets (> 6)

#### Strategy 1: Split into focused slides

```markdown
<!-- BEFORE: 9 bullets, score 65 -->
# Big Topic
- Point 1 ... - Point 9

<!-- AFTER: 2 slides, score 100 each -->
# Big Topic: Core
- Point 1
- Point 2
- Point 3
- Point 4

---

# Big Topic: Details
- Point 5
- Point 6
- Point 7
```

**Strategy 2: Consolidate** by merging related bullets.

### Content too long (> 350 chars)

Split into two slides by topic, or remove filler words.

### Code too long (> 10 lines)

1. Remove comments from code examples
2. Show only the key excerpt, add "See full implementation in ..." below
3. Split interface and implementation across two slides

### Title too long (> 35 chars)

```markdown
<!-- BEFORE: 47 chars -->
# A Comprehensive Introduction to Machine Learning Concepts

<!-- AFTER: 21 chars -->
# Intro to ML Concepts
```

### Content too short (< 50 chars)

Add explanatory context before or after code blocks.

### Combined issues (bullets + content + lines)

Root cause is usually a slide covering too many topics. Split into 2-3 focused slides.

## Decision Tree

```text
Is slide failing (< 70)?
  Yes: Fix immediately
    Multiple issues? Split into 2-3 slides
    Single issue? Apply targeted fix
  No: Is it < 80?
    Yes: Suggest improvements
    No: Leave as-is unless user requests
```

## Special Cases

- **Exercise slides** (title contains "Exercise" or "TODO"): Content limit relaxed to 450 chars
- **Disable rules per-slide**: `<!-- slidegauge: disable content/too_long, bullets/too_many -->`

## Best Practices

1. Always show the user results before fixing silently
2. Explain why each fix improves the slide
3. Get user approval before major changes (splitting slides, removing content)
4. Preserve technical accuracy and user intent
5. Re-validate after fixes to confirm improvement
