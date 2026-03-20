---
name: conference-talk-builder-petems
description: Build conference talk outlines and iA Presenter slides using the Story Circle framework, tuned to Peter's DevOps/infra community voice. Use when the user wants to structure a tech talk, create presentation slides, or needs help organising talk ideas.
license: MIT
allowed-tools:
  - Bash
  - Read
  - WebFetch
---

> Based on the excellent content creation skills by Nick Nisi.
> Original: <https://github.com/nicknisi/claude-plugins/tree/main/plugins/content>
> This is my own personal take on that flow, tuned to my voice and preferences.

# Peter's Conference Talk Builder

Build compelling conference talk outlines and iA Presenter markdown slides using the Story Circle narrative framework, with Peter's DevOps/infra community perspective baked in.

## Process

Follow these steps in order when building a conference talk:

### 1. Gather Information

Ask the user for:

- Talk title and topic
- Target audience and their expected knowledge level
- Main points they want to cover
- Brain dump of everything they know about the topic
- Problem they're solving or story they're telling
- Any constraints (time limit, specific technologies, etc.)

### 2. Research the Topic

Use WebFetch to gather context on the talk's theme and fill in gaps from the brain dump.

**What to research:**

- The topic itself: current state of the art, recent developments, community sentiment
- Related talks: has someone given a similar talk recently? What angle did they take?
- Supporting data: stats, benchmarks, release notes, or blog posts that strengthen the narrative
- The conference or meetup (if known): what's the vibe, who's the audience, what other talks are on the schedule?

**How to research:**

1. Start with any URLs the user provided in their brain dump
2. Fetch relevant project pages, documentation, or blog posts for technical grounding
3. Look for real numbers, timelines, and specifics that make the talk concrete (not hand-wavy)

The goal is not to become an expert, but to arm the speaker with enough context and supporting detail to tell a credible, grounded story.
If the user already has deep experience with the topic, the research phase is lighter (focus on recent developments and what the audience might already know).
If the user is exploring a newer area, spend more time here.

Share a brief summary of what you found with the user before moving to the outline. This gives them a chance to correct misunderstandings or highlight what's most relevant.

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

### 5. Generate iA Presenter Slides

Read `references/ia-presenter-syntax.md` for markdown formatting rules.

Create slides that:

- Use `---` to separate slides
- Add tabs before content that should be visible on slides
- Leave speaker notes without tabs (spoken text only)
- Include comments with `//` for reminders
- Format code blocks with proper syntax highlighting
- Keep slides focused on one concept each

Structure the slide deck:

- Title slide
- Introduction slide with your photo/bio
- One or more slides per Story Circle step
- Code examples broken across multiple slides for readability
- Closing slide with contact info and resources

### 6. Refine and Iterate

After showing the slides:

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
- `references/ia-presenter-syntax.md` - Complete iA Presenter markdown syntax reference. Read this when generating slides.

## Example Workflow

User: "I want to create a talk about migrating from Puppet to Ansible"

1. Gather their experience, main points, and target audience
2. Research the topic: fetch Puppet's recent release notes and deprecation timeline, check the Ansible migration guide, look for similar talks at recent ConfigMgmtCamp or PuppetConf events
3. Share research summary with user for validation
4. Read `story-circle.md`
5. Map their content:
   - Introduction: Current Puppet-managed infrastructure, been running it for years
   - Problem: Puppet module ecosystem shrinking, team struggling to hire Puppet devs
   - Exploration: Evaluated Ansible, Salt, and just staying on Puppet
   - Experimentation: Pilot migration of the monitoring stack
   - Solution: Incremental migration strategy with both tools running in parallel
   - Challenges: Hiera data translation, module dependency untangling
   - Apply Knowledge: Full infrastructure migration over six months
   - Results: Smaller codebase, easier onboarding, lessons learned about config management assumptions
6. Read `ia-presenter-syntax.md`
7. Generate markdown slides with proper formatting
8. Iterate based on feedback
