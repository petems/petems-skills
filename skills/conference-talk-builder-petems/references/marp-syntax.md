# MARP Slide Syntax Reference

Quick reference for creating slides with [MARP](https://marp.app/).

## Frontmatter

Every deck starts with this YAML block:

```yaml
---
marp: true
theme: default
paginate: true
size: 16:9
---
```

## CSS Style Block

Place a `<style>` block immediately after the frontmatter to set base styles,
breadcrumb formatting, and section colour classes.

```html
<style>
  section {
    font-size: 28px;
  }
  header {
    font-size: 14px;
    color: #666;
  }
  h1 {
    font-size: 42px;
  }
  h2 {
    font-size: 36px;
  }
  h3 {
    font-size: 30px;
  }

  /* Title slide */
  section.title-slide {
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
    color: white;
  }
  section.title-slide h1 {
    font-size: 52px;
  }

  /* Section divider colour classes */
  section.part-blue {
    background: linear-gradient(135deg, #2196F3 0%, #1976D2 100%);
    color: white;
  }
  section.part-green {
    background: linear-gradient(135deg, #4CAF50 0%, #388E3C 100%);
    color: white;
  }
  section.part-amber {
    background: linear-gradient(135deg, #FF9800 0%, #F57C00 100%);
    color: white;
  }
  section.part-purple {
    background: linear-gradient(135deg, #9C27B0 0%, #7B1FA2 100%);
    color: white;
  }
  section.part-navy {
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
    color: white;
  }
</style>
```

### Colour palette summary

| Class         | Primary | Gradient end | Use for                   |
|---------------|---------|--------------|---------------------------|
| `part-blue`   | #2196F3 | #1976D2      | Technical / core sections |
| `part-green`  | #4CAF50 | #388E3C      | Solutions / results       |
| `part-amber`  | #FF9800 | #F57C00      | Challenges / warnings     |
| `part-purple` | #9C27B0 | #7B1FA2      | Exploration / experiments |
| `part-navy`   | #1a1a2e | #16213e      | Title / closing           |

## Slide Separators

Use `---` on its own line between slides:

```markdown
# Slide one

Content here.

---

# Slide two

More content.
```

## Slide Types

### Title slide

```markdown
<!-- _class: lead title-slide -->

# Talk Title

## Speaker Name - Conference 2026

<!-- Your opening speaker notes go here -->
```

### Questions/Goals slide

```markdown
# Questions we'll answer

- Why does X matter?
- How do you get started with Y?
- What are the common pitfalls?
```

### Agenda slide

```markdown
# Agenda

### Part 1: The status quo
### Part 2: Down the rabbit hole
### Part 3: What we found
### Part 4: Lessons learned
```

### Section divider

Use a `lead` class plus one of the colour classes. Clear the header so the
breadcrumb does not appear on full-bleed dividers.

```markdown
<!-- _class: lead part-blue -->
<!-- _header: "" -->

# Part 1: The status quo
```

### Content slide with breadcrumb

Set the header directive to show the audience where they are. Bold the active
section.

```markdown
<!-- header: "**The status quo** > Down the rabbit hole > What we found > Lessons learned" -->

# Current deployment pipeline

- Jenkins runs nightly builds
- Artefacts pushed to S3
- Manual promotion to production
```

To change the active section on a later slide, set a new `header` directive.

## Speaker Notes

Use HTML comments anywhere in a slide:

```markdown
# Slide title

- Bullet one
- Bullet two

<!-- Mention the outage from last March here. Pause for effect. -->
```

This is the biggest syntax difference from iA Presenter, which used a tab/no-tab
system. In MARP, everything visible on the slide is normal Markdown. Speaker
notes live in HTML comments.

## Formatting Rules

- **Sentence case** for headings (not Title Case)
- **No trailing periods** on bullet points
- Use **single dashes** for lists (not asterisks)
- Use **backticks** for inline code
- Use **bold** for emphasis (not italics or all-caps)
- **One idea per slide**
- **3-5 bullets max** per slide

## Code Blocks

Standard fenced code blocks, no special prefix needed:

````markdown
```terraform
resource "aws_instance" "web" {
  ami           = "ami-0c55b159cbfafe1f0"
  instance_type = "t3.micro"
}
```
````

## Images

Standard Markdown images:

```markdown
![Architecture diagram](./images/architecture.png)
```

For background images, use MARP's image directive:

```markdown
![bg right:40%](./images/photo.jpg)
```

## Tables

Standard Markdown tables:

```markdown
| Tool    | Speed  | Complexity |
|---------|--------|------------|
| Puppet  | Medium | High       |
| Ansible | Fast   | Low        |
```

## Export Commands

### HTML (single file, good for sharing)

```bash
npx @marp-team/marp-cli@latest --no-stdin talk.md -o talk.html
```

### PPTX (for conferences that require PowerPoint)

```bash
npx @marp-team/marp-cli@latest --no-stdin talk.md -o talk.pptx
```

### PDF

```bash
npx @marp-team/marp-cli@latest --no-stdin talk.md -o talk.pdf
```

### Editable PPTX workflow

If you need to tweak individual slides after generation:

1. Export to PPTX with the command above
2. Open in PowerPoint or Google Slides
3. Edit as needed
4. Keep the `.md` source as the canonical version

### Preview (live reload)

```bash
npx @marp-team/marp-cli@latest --no-stdin -s talk.md
```
