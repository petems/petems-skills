---
name: blog-post-writer-petems
description: Transform brain dumps into blog posts in Peter's casual, self-deprecating British voice. Use when the user says "write a blog post," "draft a post," "write about [topic]," or provides scattered ideas that need shaping into a cohesive narrative.
license: MIT
allowed-tools:
  - Bash
  - Read
  - WebFetch
---

> Based on the excellent content creation skills by Nick Nisi.
> Original: <https://github.com/nicknisi/claude-plugins/tree/main/plugins/content>
> This is my own personal take on that flow, tuned to my voice and preferences.

# Peter's Blog Post Writer

Transform unstructured brain dumps into blog posts that sound like Peter.

## Process

### 1. Receive the Brain Dump

Accept whatever the user provides:

- Scattered thoughts and ideas
- Technical points to cover
- Code examples or commands
- Conclusions or takeaways
- Links to reference
- Random observations

Don't require organisation. The mess is the input.

**Clarify constraints** (if not provided, ask about):

- Target length (see `references/post-template.md` for word count ranges)
- Target audience (if different from general developer peers)
- Whether this is a first draft or revision of existing content
- Any specific sections, topics, or angles to include or exclude

### 2. Read Voice and Tone

Load `references/voice-tone.md` as the baseline voice guide.

**Then calibrate against recent writing:**

1. Fetch `https://petersouter.xyz/posts` to find the 2-3 most recent posts
2. Fetch and read those posts
3. Note any patterns that extend or differ from the static reference: new phrases, tone shifts, topic-specific voice adjustments

The static reference captures established patterns. The live fetch catches evolution. When they conflict, prefer the recent posts, as voice is a living thing. If the site cannot be fetched, rely on the static voice guide alone.

Key characteristics (read the full reference for details and examples):

- Casual, self-deprecating, British
- Parenthetical asides everywhere
- Brutally honest about failures and scope creep
- Bold for rallying cries
- Niche references and passion tangents
- Community-embedded with real names and relationships

### 3. Choose a Narrative Framework

Match the content to the best framework. Read the corresponding reference file before writing.

**Quick-match shortcuts** (covers ~80% of posts):

- Personal journey, **Story Circle** (`references/story-circle.md`)
- Teaching a concept, **Progressive Disclosure** (`references/progressive-disclosure.md`)
- Bug fix story, **PAS** (`references/problem-agitation-solution.md`)
- Tool comparison, **Compare & Contrast** (`references/compare-contrast.md`)
- Something broke, **Post-mortem** (`references/post-mortem.md`)
- Technical decision, **SCQA** (`references/scqa.md`)
- Contrarian take, **The Sparkline** (`references/the-sparkline.md`)
- Absurd complexity, **Kafkaesque Labyrinth** (`references/kafkaesque-labyrinth.md`)

**Category decision tree** (for the other 20%):

- "I changed through this", **Journey & Transformation**
- "The structure IS the story", **Structural Techniques**
- "There's a surprise or tension", **Tension & Contrast**
- "Making a logical case", **Analytical & Persuasive**
- "Mood/feeling drives the piece", **Atmospheric & Experimental**

#### Journey & Transformation

| Framework | Reference | One-liner |
| --- | --- | --- |
| Story Circle | `references/story-circle.md` | 8-step hero's journey for personal transformation arcs |
| Three-Act | `references/three-act.md` | Classic setup/confrontation/resolution narrative spine |
| Freytag's Pyramid | `references/freytags-pyramid.md` | 5-phase dramatic arc with explicit climax mapping |
| The Metamorphosis | `references/the-metamorphosis.md` | Identity-level change, the author becomes someone different |
| Existential Awakening | `references/existential-awakening.md` | Profound realisation that shifts relationship to work |

#### Structural Techniques

| Framework | Reference | One-liner |
| --- | --- | --- |
| In Medias Res | `references/in-medias-res.md` | Start in the middle of the action, backfill context |
| Reverse Chronology | `references/reverse-chronology.md` | Tell it backwards: outcome first, origin last |
| Nested Loops | `references/nested-loops.md` | Layer stories inside each other like Russian dolls |
| The Spiral | `references/the-spiral.md` | Revisit the same concept with deeper understanding each pass |
| The Petal | `references/the-petal.md` | Multiple stories radiating from a central theme |

#### Tension & Contrast

| Framework | Reference | One-liner |
| --- | --- | --- |
| Kishotenketsu | `references/kishotenketsu.md` | 4-act twist without conflict: recontextualise, don't confront |
| The Sparkline | `references/the-sparkline.md` | Oscillate between "what is" and "what could be" |
| The False Start | `references/the-false-start.md` | Begin with the wrong story, then restart with truth |
| Converging Ideas | `references/converging-ideas.md` | Unrelated threads that connect to a single insight |
| Catch-22 | `references/catch-22.md` | Paradox where the rules create an impossible situation |
| The Rashomon | `references/the-rashomon.md` | Same event from multiple contradictory perspectives |

#### Analytical & Persuasive

| Framework | Reference | One-liner |
| --- | --- | --- |
| SCQA | `references/scqa.md` | Situation-Complication-Question-Answer for logical problem-solving |
| Progressive Disclosure | `references/progressive-disclosure.md` | Simple-to-complex layering for teaching concepts |
| Compare & Contrast | `references/compare-contrast.md` | Structured evaluation of trade-offs between options |
| PAS | `references/problem-agitation-solution.md` | Punchy problem, pain, fix for short optimisation stories |
| Post-mortem | `references/post-mortem.md` | Incident retrospective with timeline and lessons |
| Socratic Path | `references/socratic-path.md` | Chain of questions leading to self-discovered conclusions |

#### Atmospheric & Experimental

| Framework | Reference | One-liner |
| --- | --- | --- |
| Comedian's Set | `references/comedians-set.md` | Setup/punchline structure for myth-busting and reframes |
| Kafkaesque Labyrinth | `references/kafkaesque-labyrinth.md` | Systemic absurdity where the villain is the system itself |
| Sisyphean Arc | `references/sisyphean-arc.md` | Find meaning in repetitive work that never ends |
| Stranger's Report | `references/strangers-report.md` | Fresh-eyes outsider perspective on normalised strangeness |
| The Waiting | `references/the-waiting.md` | Something promised that never arrives, meaning from anticipation |

Not every post maps cleanly to one framework. Hybrid approaches are fine. Each framework's reference includes Combination Notes for pairing. Use a framework as a starting structure, not a straitjacket.

`voice-tone.md` and `post-template.md` are always loaded. Load only one framework reference in addition. Do not preload all twenty-seven.

### 4. Outline the Post

Apply the chosen framework to the brain dump material:

- Map the user's points to the framework's steps/sections
- Identify gaps: what's missing that the framework needs?
- Decide section headers (descriptive and specific, not generic placeholders)
- Determine where code examples and specific details will land

If the content doesn't fit the framework cleanly, adapt. The framework is scaffolding, not a cage.

### 5. Write in Peter's Voice

Apply voice characteristics:

**Opening:**

- Hook with a personal anecdote or self-deprecating admission
- Set up the problem or question honestly
- Don't be afraid to undercut yourself right away

**Body:**

- Vary paragraph length
- Use short paragraphs for emphasis
- Include specific details (tool names, commands, version numbers, error messages)
- Show vulnerability and honesty about failures
- Use inline code formatting naturally
- Break up text with headers
- Parenthetical asides for colour commentary
- Let tangents happen (but be aware you're doing it)

**Technical content:**

- Assume reader knowledge but explain context when needed
- Show actual commands, configs, and real output
- Be honest about limitations and pain points
- Drop specific tool names casually: `puppet apply`, `terraform plan`, `vault write`

**Tone modulation:**

- Technical sections: detailed, specific, still conversational
- Personal sections: vulnerable, self-deprecating, honest
- Community sections: warm, name-dropping real people, genuine enthusiasm
- Keep it conversational throughout

**Ending:**

- Tie back to opening
- Practical takeaway or call to action
- Self-aware closer (optional: acknowledge the rambling)
- Bold rallying cry if it fits: **DO THE DAMN THING**

### 6. Review and Refine

Check the post:

- Does it sound like Peter talking, not a polished press release?
- Is there honest vulnerability (failures, scope creep, missed deadlines)?
- Are technical details specific (real tools, real commands, real output)?
- Are there parenthetical asides that add colour?
- Are paragraphs varied in length?
- Is humour self-aware and natural, not forced?
- Does it end with momentum?
- British English throughout (favourite, realised, colour)?

**AI slop check:**

1. Load `references/ai-slop-checklist.md` for the curated guidance and Peter-specific nuances
2. Fetch the current "words to watch" from Wikipedia by calling:

   ```text
   https://en.wikipedia.org/w/api.php?action=parse&page=Wikipedia:Signs_of_AI_writing&prop=wikitext&format=json
   ```

   Extract the `{{tmbox}}` "Words to watch" lists and the AI vocabulary word list from the response. These evolve as AI writing patterns change, as newer models drop old tells and develop new ones.
3. Scan the draft for vocabulary clusters, formulaic transitions, superficial -ing phrases, and structural tells. One hit is normal; a pattern means the LLM was writing on autopilot instead of in Peter's voice.

If the API fetch fails, fall back to the static checklist alone.

Show the post to the user for feedback and iterate.

**Revision strategy:**

- Re-read `references/voice-tone.md` before revising to recalibrate
- Focus changes on the specific feedback. Don't rewrite unrelated sections
- Preserve the overall narrative structure unless the user explicitly requests restructuring
- If feedback is vague ("make it better"), ask what specifically feels off

## Output Format

Format posts using `references/post-template.md` as the structural template. This defines the frontmatter schema and file format.

For detailed voice do's and don'ts, see `references/voice-tone.md`.

## Example Patterns

### Opening hooks

```markdown
So I finally got around to writing about the Puppet 7 migration. I know, I know,
I said I'd do this months ago. In my defence, the migration itself took longer
than expected (shocking, I realise).
```

```markdown
Right, so here's the thing about Terraform state: nobody actually understands it.
I mean, we all pretend we do. But then you run `terraform plan` at 3am during an
incident and suddenly you're staring at 47 resources that want to be destroyed
and you're thinking "wait, what?"
```

### Emphasis through structure

```markdown
Then it clicked.

The problem wasn't the config. The problem was that I'd been cargo-culting a
pattern from three jobs ago without ever questioning whether it actually made
sense here.
```

### Vulnerability

```markdown
I'll be honest, I completely forgot to set the draft flag. So that half-finished
post about Vault was live for about six hours before anyone told me. Classic.
```

### Technical details

```markdown
The fix was embarrassingly simple. One line in the `puppet.conf`:
`environment_timeout = unlimited`. That was it. Three days of debugging
for one line.
```

### Conclusions

```markdown
**DO THE DAMN THING.** Write the post. Submit the talk. Ship the PR. It doesn't
have to be perfect. It just has to exist.
```

## Bundled Resources

### References

- `references/voice-tone.md` - Complete voice and tone guide. Read this first to capture Peter's style.
- `references/post-template.md` - Output format template with frontmatter schema and structural skeleton.
- `references/ai-slop-checklist.md` - AI writing tells to scan for during review. Adapted from Wikipedia's field guide.

**Narrative frameworks** (read the one that matches the content. Do not preload all twenty-seven):

Journey & Transformation:

- `references/story-circle.md` - 8-step hero's journey for personal transformation arcs
- `references/three-act.md` - Classic setup/confrontation/resolution narrative spine
- `references/freytags-pyramid.md` - 5-phase dramatic arc with explicit climax mapping
- `references/the-metamorphosis.md` - Identity-level change, the author becomes someone different
- `references/existential-awakening.md` - Profound realisation that shifts relationship to work

Structural Techniques:

- `references/in-medias-res.md` - Start in the middle of the action, backfill context
- `references/reverse-chronology.md` - Tell it backwards: outcome first, origin last
- `references/nested-loops.md` - Layer stories inside each other like Russian dolls
- `references/the-spiral.md` - Revisit the same concept with deeper understanding each pass
- `references/the-petal.md` - Multiple stories radiating from a central theme

Tension & Contrast:

- `references/kishotenketsu.md` - 4-act twist without conflict: recontextualise, don't confront
- `references/the-sparkline.md` - Oscillate between "what is" and "what could be"
- `references/the-false-start.md` - Begin with the wrong story, then restart with truth
- `references/converging-ideas.md` - Unrelated threads that connect to a single insight
- `references/catch-22.md` - Paradox where the rules create an impossible situation
- `references/the-rashomon.md` - Same event from multiple contradictory perspectives

Analytical & Persuasive:

- `references/scqa.md` - Situation-Complication-Question-Answer for logical problem-solving
- `references/progressive-disclosure.md` - Simple-to-complex layering for teaching concepts
- `references/compare-contrast.md` - Structured evaluation of trade-offs between options
- `references/problem-agitation-solution.md` - Punchy problem, pain, fix for short optimisation stories
- `references/post-mortem.md` - Incident retrospective with timeline and lessons
- `references/socratic-path.md` - Chain of questions leading to self-discovered conclusions

Atmospheric & Experimental:

- `references/comedians-set.md` - Setup/punchline structure for myth-busting and reframes
- `references/kafkaesque-labyrinth.md` - Systemic absurdity where the villain is the system itself
- `references/sisyphean-arc.md` - Find meaning in repetitive work that never ends
- `references/strangers-report.md` - Fresh-eyes outsider perspective on normalised strangeness
- `references/the-waiting.md` - Something promised that never arrives, meaning from anticipation

## Workflow Example

User provides brain dump:

```text
thoughts on migrating puppet 4 to puppet 7
- we put it off for ages, kept saying "next quarter"
- finally got forced into it when puppet 4 went EOL
- the hiera 5 migration was the worst part
- broke everything in staging first (on purpose, kind of)
- took 3 months instead of the 3 weeks we estimated
- learned a ton about our own tech debt along the way
- would actually recommend doing it incrementally
- conclusion: just start, stop waiting for the perfect time
```

Process:

1. Read voice-tone.md
2. Choose framework: this is a personal journey with a "just do it" conclusion, so **Story Circle** with PAS elements
3. Outline: Status quo (stuck on Puppet 4), Problem (EOL forcing hand), Journey (Hiera 5 pain), Realisation (incremental approach), Outcome (3 months of learning)
4. Write opening hook about procrastination and "next quarter" promises
5. Show vulnerability about the 3-week estimate vs 3-month reality
6. Include specific Puppet/Hiera commands and errors naturally
7. Conclude with **DO THE DAMN THING** energy about starting migrations
8. Review for conversational tone, British English, and specific details

Sample output (opening paragraphs):

```markdown
I'm going to sheepishly admit something: we said "next quarter" about the Puppet 7
migration for the better part of two years. Every planning session, someone would
bring it up, we'd all nod solemnly, and then we'd collectively decide that this
quarter was definitely not the right time.

Then Puppet 4 went EOL and suddenly "next quarter" became "right now, actually."

Here's the thing about forced migrations (and I say this as someone who's been
through more than I'd like to count): they're never as bad as the dread that
preceded them. They're also never as quick as your estimate says they'll be. We
said three weeks. It took three months. But those three months taught us more
about our own infrastructure than the previous two years of "next quarter" ever
did.
```

Notice: self-deprecating opening, parenthetical aside, specific timeline details, honest about the estimate being wrong, conversational British tone throughout.
