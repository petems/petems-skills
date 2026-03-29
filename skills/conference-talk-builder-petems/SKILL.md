---
name: conference-talk-builder-petems
description: Build conference talk outlines and MARP slides using the Story Circle framework, tuned to Peter's DevOps/infra community voice. Use when the user wants to structure a tech talk, create presentation slides, or needs help organising talk ideas.
license: MIT
allowed-tools:
  - Bash
  - Read
  - Write
  - WebFetch
  - WebSearch
---

> Based on the excellent content creation skills by Nick Nisi.
> Original: <https://github.com/nicknisi/claude-plugins/tree/main/plugins/content>
> This is my own personal take on that flow, tuned to my voice and preferences.

# Peter's Conference Talk Builder

Build compelling conference talk outlines and MARP Markdown slides using the Story Circle narrative framework, with Peter's DevOps/infra community perspective baked in.

## Peter's Voice

Write slides and speaker notes in a conversational, slightly informal British English tone. Think "experienced engineer chatting at a pub after the meetup" rather than "corporate keynote."

- Self-deprecating humour is good. Dry wit over slapstick.
- Default to showing real code/config, not pseudocode. DevOps audiences want to see the YAML, the Terraform, the Dockerfile.
- Swearing: keep it PG-13 on slides, max out at Rated-R in speaker notes.
  Occasional mild swearing or minced oaths are fine for emphasis, quoting,
  or when the moment genuinely calls for it. Swearing gets its power from
  its shock value, so use it sparingly and responsibly. When in doubt, ask
  the user if the context warrants it.
- Avoid corporate jargon ("synergies", "leverage", "paradigm shift"). Say what you mean.
- Prefer concrete examples over abstract statements. "We cut deploy time from 45 minutes to 3" beats "we significantly improved deployment velocity."

## Process

Follow these steps in order when building a conference talk:

### 1. Gather Information

Start with whatever the user gives you, even if it's just a topic and a vague idea. Ask follow-up questions to fill gaps, but don't front-load a big questionnaire. Tease out the story through conversation.

Key things to establish (over the course of conversation, not all at once):

- What's the talk about and what's the story arc?
- Who's in the room and what do they already know?
- How long is the slot?
- What's the one thing the audience should remember walking out?
- Any brain dump of experiences, anecdotes, or technical details they want to include

### 2. Research the Topic

The goal is not to become an expert, but to arm the speaker with enough context and
supporting detail to tell a credible, grounded story. If the user already has deep
experience with the topic, keep research light (focus on recent developments and what
the audience might already know). If they're exploring a newer area, spend more time here.

#### Step 2a -- Tool Inventory & MCP Audit

Before doing any research, inventory what's available. Check every MCP server currently connected and every built-in tool you have access to.

**Always available (built-in):**

- **WebSearch** / **WebFetch** handle the majority of research needs and require no setup.

**Recommended MCP servers:** Read `references/recommended-mcps.md` for a table of
useful MCP servers for research (search engines, doc lookup, academic papers, image
search, etc.). If any are missing and would be particularly useful for this talk's
topic, mention them to the user as options worth adding.

**Workplace knowledge tools** (Confluence, Glean, Notion, Google Drive, Slack, etc.):
These can be goldmines for work-related talks, but raise a flag before using them.
Internal docs may contain private roadmap items, unreleased product details, or
internal-only metrics that shouldn't appear in a public talk. Always ask the user
before searching these, and flag anything that looks potentially sensitive.

**Other connected MCPs:** Scan all other connected MCP servers. If you spot servers for YouTube, Reddit, Twitter/X, Hacker News, or any domain-specific tool relevant to the talk topic, ask the user if they'd like to include them in the research sweep.

**MCP count guardrail:** If you're planning to actively use more than WebFetch,
WebSearch, and 3 additional MCP servers during research, pause and check with the
user. Too many tools at once gets unwieldy: responses slow down, context gets noisy,
and it's harder to track what came from where. Ask the user to pick the 2-3 most
relevant.

**Fallback:** If no web tools are available at all, rely on training knowledge and ask the user to upload reference materials (PDFs, bookmarks, notes, etc.).

#### Step 2b -- Topic Scoping & Angle Generation

Generate 3-5 research angles tailored to the topic type. Examples by category:

- **Technical** (e.g. DevOps): current industry state, recent tooling shifts, common pain points, compelling case studies, counter-narratives
- **Hobby / personal** (e.g. powerlifting, gigging): recent news or moments in the space, interesting stats, cultural context, relatable analogies, "why should a tech audience care" hooks
- **Analytical** (e.g. baseball, ergonomics): key data/studies, common misconceptions, surprising findings, practical takeaways

Present the angles to the user for confirmation or adjustment before proceeding.

#### Step 2c -- Broad Search Sweep

For each confirmed research angle:

- Run 2-3 searches varying the query framing (keyword-based via WebSearch/DuckDuckGo/Brave, semantic via Exa if available, structured via Tavily if available, academic via Paper Search if the topic warrants it)
- **Use domain filters with WebSearch** to target specific source types:
  - Existing talks: `allowed_domains: ["youtube.com", "speakerdeck.com", "slideshare.net"]`
  - Community sentiment: `allowed_domains: ["news.ycombinator.com", "reddit.com", "lobste.rs"]`
  - Conference context: search for the specific conference schedule or CFP page
- If Context7 is available and the topic involves specific libraries or frameworks, pull current docs to verify technical claims. Audiences notice when slides say "new in v3" and v4 has been out for six months.
- Aim for breadth: mix source types (articles, papers, blog posts, talks, data sets) and perspectives
- Capture 5-10 promising leads per angle: URL, title, one-line note on why it looks useful
- Use WebFetch to deep-read the most relevant 2-3 results from each angle

#### Step 2d -- Deep Dives

Fetch and read the most promising 5-10 sources from the sweep. For each, extract:

- **Key claims with specifics** -- numbers, dates, names
- **Surprising or counterintuitive findings**
- **Quotable phrases or framings** worth referencing in the talk
- **Narrative threads** that could structure sections of the talk
- **Audience interaction hooks** -- moments that invite questions, polls, or demos

#### Step 2e -- Synthesis

Compile everything into `research_brief.md` with these sections:

1. **Executive Summary** -- the topic landscape in 3-5 sentences
2. **Findings by Angle** -- key takeaways grouped under each research angle from Step 2b
3. **Hooks & Surprises** -- the 3-5 most compelling facts, stories, or stats for grabbing attention
4. **Narrative Arc Options** -- 2-3 ways to structure the talk, each with a one-sentence rationale
5. **Annotated Source List** -- each source with a note on what it's useful for
6. **Gaps & Open Questions** -- things worth knowing that the research didn't surface, flagged for the user to fill in with personal experience or further digging

Save the brief and present it to the user before moving to the outline. This gives them a chance to correct misunderstandings, flag what's most relevant, or say "actually, skip that angle."

#### Slide imagery

Source slide imagery separately during the slide-building stage (Step 5), not during
research. Use Unsplash to find thematic images with `orientation: "landscape"` for
widescreen slides. Always use get_photo_attribution and include the credit on a
references slide. Only do this if the user wants images; many DevOps talks are
code/text-heavy and that's fine.

### 3. Read the Story Circle Framework

Load `references/story-circle.md` to understand the eight-step narrative structure.

The framework maps tech talks to:

- Top half: Established practices and order
- Bottom half: Disruption and experimentation

### 4. Create the Outline

Structure the talk using the eight Story Circle steps:

1. Introduction - Current status quo
2. Problem Statement - What needs solving
3. Exploration - Initial attempts
4. Experimentation - Deep investigation
5. Solution - The breakthrough
6. Challenges - Implementation difficulties
7. Apply Knowledge - Integration into project
8. Results & Insights - Lessons learned

Map the user's content to these steps. Show this outline to the user and refine based on feedback.

### 5. Generate MARP Slides

Read `references/marp-syntax.md` for Markdown formatting rules.

Save the slide deck to `<talk-title-slug>.md` in the current directory. Ask the user if they want it somewhere else.

Create slides that:

- Start with the MARP frontmatter block (`marp: true`, `theme: default`, `paginate: true`, `size: 16:9`)
- Include the CSS `<style>` block from the syntax reference for base styles and section colour classes
- Use `---` to separate slides
- Use `<!-- _class: lead part-NAME -->` for section dividers, mapped to Story Circle groups
- Use `<!-- header: "**Active** > Other > Other" -->` for breadcrumb navigation
- Use `<!-- speaker notes here -->` HTML comments for speaker notes
- Format code blocks with proper syntax highlighting
- Keep slides focused on one concept each

Structure the slide deck:

- Title slide (`<!-- _class: lead title-slide -->`)
- Questions/goals slide
- Agenda slide with parts mapped to Story Circle groups
- Section divider + content slides for each Story Circle step
- Closing slide with contact info, resources, and QR code

After generating the `.md` file, offer to export:

```bash
npx @marp-team/marp-cli@latest --no-stdin <talk-title-slug>.md -o <talk-title-slug>.html
npx @marp-team/marp-cli@latest --no-stdin <talk-title-slug>.md -o <talk-title-slug>.pptx
```

### Adapting the Framework

Not every talk fits all 8 steps neatly. Use the Story Circle as a guide, not a straitjacket.

- **Lightning talks (5-10 min):** Compress to Problem, Exploration, Solution, Takeaway.
- **Demo-heavy talks:** The "Experimentation" and "Solution" steps might be live demos with minimal slides. Focus slides on setup/context and wrap-up.
- **"State of the ecosystem" surveys:** The "journey" is the audience's journey through the landscape rather than a single problem/solution arc.
- **Panel prep:** Structure talking points around the Story Circle but expect to jump between steps based on questions.

### 6. Refine and Iterate

After showing the slides:

- Run `references/ai-slop-checklist.md` against the draft. Scan slides and speaker
  notes for AI vocabulary clusters, inflated significance, and formatting tells.
  Fix anything that reads robotic before asking for human feedback.
- Ask if sections need expansion or compression
- Check if code examples need better formatting
- Verify the story flow makes sense
- Adjust based on user feedback

## Key Principles

**Tell a Story**: You don't need to be an expert. Focus on how you approached a problem and solved it. Be honest about the bits that went wrong (that's where the best stories live).

**Keep It Readable**: Break code across slides. Use syntax highlighting. Test on bad projectors (consider light themes).

**Engage the Audience**: Use humour where appropriate. Ask questions. Make eye contact. If you've got a tangent that connects to the topic, let it breathe a bit.

**Make Follow-up Easy**: Include a memorable URL or QR code on the final slide linking to resources.

## Bundled Resources

### References

- `references/story-circle.md` - Eight-step Story Circle framework with examples. Read this first to understand the narrative structure.
- `references/marp-syntax.md` - Complete MARP Markdown syntax reference. Read this when generating slides.
- `references/recommended-mcps.md` - Table of recommended MCP servers for research. Read during Step 2a (Tool Inventory) to check what's available and suggest additions.
- `references/ai-slop-checklist.md` - AI writing tells checklist. Read during Step 6 (Refine and Iterate) to catch robotic phrasing in slides and speaker notes.

## Example Workflow

User: "I want to create a talk about migrating from Puppet to Ansible"

1. Gather their experience, main points, and target audience
2. Research the topic: fetch Puppet's recent release notes and deprecation timeline, check the Ansible migration guide, look for similar talks at recent ConfigMgmtCamp or PuppetConf events
3. Share research summary with user for validation
4. Read `references/story-circle.md`
5. Map their content:
   - Introduction: Current Puppet-managed infrastructure, been running it for years
   - Problem: Puppet module ecosystem shrinking, team struggling to hire Puppet devs
   - Exploration: Evaluated Ansible, Salt, and just staying on Puppet
   - Experimentation: Pilot migration of the monitoring stack
   - Solution: Incremental migration strategy with both tools running in parallel
   - Challenges: Hiera data translation, module dependency untangling
   - Apply Knowledge: Full infrastructure migration over six months
   - Results: Smaller codebase, easier onboarding, lessons learned about config management assumptions
6. Read `references/marp-syntax.md`
7. Generate MARP Markdown slides with proper formatting
8. Export to HTML and PPTX via marp-cli
9. Iterate based on feedback
