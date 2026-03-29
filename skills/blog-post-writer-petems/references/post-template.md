# Blog Post Output Template

## File Format

Posts are written in Markdown (`.md`).

## Frontmatter

Every post must include YAML frontmatter at the top:

```yaml
---
title: "Post Title Here"
date: YYYY-MM-DD
description: "A 1-2 sentence summary for SEO and social sharing."
tags:
  - tag1
  - tag2
draft: false
---
```

### Required Fields

- **title** (string): The post title
- **date** (date): Publication date in `YYYY-MM-DD` format
- **description** (string): 1-2 sentence summary for SEO and social cards
- **tags** (string[]): Array of topic tags
- **draft** (boolean): Set `true` to hide from published listings, `false` when ready

## Target Word Counts

- **Short post**: 500-800 words (quick takes, single insights)
- **Standard post**: 1000-1500 words (most posts)
- **Long-form**: 2000+ words (deep dives, tutorials, narratives)

Default to standard unless the user specifies otherwise.

## Structural Skeleton

```markdown
---
title: ""
date: YYYY-MM-DD
description: ""
tags: []
draft: false
---

# Opening Hook

[1-2 paragraphs: Set up tension, question, or current position]

## Section 1: Context/Setup

[Establish the situation, background, or problem]

## Section 2: Journey/Discovery

[Show the process, experimentation, or narrative middle]

## Section 3: Resolution/Insight

[Present the breakthrough, solution, or realisation]

## Closing

[Tie back to opening, forward-looking perspective, actionable takeaway]
```

Section headers should be descriptive and specific to the content. The names above are structural placeholders, not literal headers.
