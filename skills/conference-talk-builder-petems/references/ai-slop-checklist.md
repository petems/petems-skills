# AI Writing Tells, Self-Review Checklist

Adapted from [Wikipedia: Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing),
which catalogs patterns statistically overrepresented in LLM output. Use this as a
final pass to catch robotic phrasing that slipped through into slides, speaker notes,
or any generated prose.

This checklist is **descriptive, not prescriptive**. A few of these patterns appear
naturally in good human writing. The signal is density: one "pivotal" is fine; five
AI vocabulary words in two paragraphs is a rewrite.

## Overused AI vocabulary

Words that spiked in frequency after 2023, corroborated by peer-reviewed studies.
Scan for clusters of these:

> additionally, align with, crucial, delve, emphasizing, enduring, enhance,
> fostering, garner, highlight (verb), interplay, intricate/intricacies,
> key (adjective), landscape (abstract), multifaceted, nuanced, pivotal, realm,
> showcase, tapestry (abstract), testament, underscore (verb), valuable, vibrant

One or two in a full piece is fine. A cluster of 3+ in a section means the LLM was
on autopilot.

**Talk-specific note:** Slides are especially unforgiving because the audience reads
them in isolation. A single "delve" on a slide is louder than one buried in a
paragraph. Speaker notes have more room, but clusters still smell robotic when read
aloud during rehearsal.

## Inflated significance

LLMs inflate importance with a small repertoire of phrases. Scan for:

- "stands as a testament"
- "plays a vital/significant/crucial/pivotal role"
- "underscores its importance"
- "watershed moment" / "key turning point"
- "indelible mark"
- "setting the stage for"
- "evolving landscape"
- "deeply rooted"
- "enduring/lasting legacy"

**The fix:** Say what actually happened. Specific facts beat vague significance.
"We cut deploy time from 45 minutes to 3" lands harder from a stage than
"a pivotal transformation in our deployment landscape."

## Superficial -ing analysis

LLMs tack present participle phrases onto sentences as fake depth:

- "...ensuring a seamless experience"
- "...highlighting its importance"
- "...emphasizing the need for"
- "...reflecting broader trends"
- "...contributing to the ecosystem"
- "...fostering a sense of community"

**The fix:** If the -ing clause adds no information the reader or audience didn't
already have, cut it. In talks especially, trailing participle phrases eat up
precious slide real estate and dilute the point.

## Promotional language

Words that read like a travel brochure or sales deck:

> breathtaking, stunning, nestled, in the heart of, boasts a, vibrant,
> rich (figurative), profound, groundbreaking (figurative), renowned,
> showcasing, exemplifies, commitment to, natural beauty,
> rich cultural tapestry/heritage

Good technical writing is enthusiastic but specific. Show the code, the config, the
metric. "I finally got the bloody thing working at 2am" beats "a vibrant and rich
developer experience."

## Vague authority

LLMs attribute claims to phantom experts:

- "Industry reports suggest..."
- "Observers have cited..."
- "Experts argue..."
- "Some critics contend..."
- "Several publications have noted..."

**The fix:** Name the source or drop the attribution. Link to the actual
documentation, blog post, or benchmark. Audiences (and readers) trust specificity
over anonymous authority.

## Formulaic transitions

These transitions read like a five-paragraph essay:

> moreover, furthermore, in addition, on the other hand, in contrast,
> it's important to note, it is worth mentioning, no discussion would be
> complete without

Good prose uses casual transitions or none at all. A line break between topics
is often better than a forced connector. For talks: "So here's the thing:",
"Anyway, the point is...", "Which brings me to..."

## Negative parallelism overuse

The "not X, it's Y" construction:

- "It's not just about X, it's about Y"
- "Not only... but also..."
- "It isn't X, it's Y"

**Nuance:** This pattern works sparingly for genuine emphasis. The tell is when
every other paragraph uses it, or when it creates false profundity from obvious
contrasts. Once per piece is the maximum before it becomes a tic.

## Rule of three

LLMs default to grouping things in threes:

- "convenient, efficient, and innovative"
- "keynote sessions, panel discussions, and networking opportunities"

When every list has exactly three items, it's suspicious. Vary the count. Two items
is fine. Four is fine. One is fine.

## Copula avoidance

LLMs replace "is" with fancier verbs:

- "serves as" instead of "is"
- "stands as" instead of "is"
- "represents" instead of "is"
- "marks" instead of "is"
- "boasts" instead of "has"
- "features" instead of "has"

Sometimes the fancy verb is right. Usually "is" is better. Directness builds trust,
whether you're writing a blog post, a slide deck, or speaker notes.

## Elegant variation

LLMs use increasingly elaborate synonyms to avoid repeating a word:

> the tool, the solution, the platform, the offering, the ecosystem

If you're talking about Terraform, just say Terraform again. If you're talking about
Kubernetes, say Kubernetes. Readers and audiences don't mind repetition of concrete
nouns. They notice when you cycle through thesaurus entries.

## Em dash overuse

LLMs use em dashes at 2-3x the rate of human writers. They substitute them for
commas, parentheses, and colons in a formulaic, "punched up" style. When every other
sentence has one, or when a comma would be more natural, it's a tell.

Peter's style avoids em dashes entirely. Use commas, periods, or parentheses instead.

## Formatting tells

- **Excessive boldface**: bolding every key term mechanically, "key takeaways" style
- **Title case in every heading**: use sentence case instead
- **Bullet + bold header + colon**: the "**Term:** Description of term" pattern in
  every list
- **Emoji decoration**: emoji before every section heading or bullet point

**Talk-specific note:** Slides should use formatting to aid comprehension, not to
decorate. One bold term per slide for emphasis is fine. Every noun bolded is noise.

## Challenges-and-future formula

The rigid "Despite its success, X faces challenges... Despite these challenges, X
continues to thrive" sandwich. If you catch yourself writing "despite" twice in a
paragraph, restructure.

## How to use this checklist

1. Finish the draft first. Don't self-censor while writing
2. Read through once scanning for vocabulary clusters
3. Read through again checking structural patterns (parallelism density, list
   uniformity, transition formality)
4. For each hit: Is this a deliberate rhetorical choice, or did the LLM default to
   it? If you can't articulate why the fancy version is better, use the plain one
5. When in doubt, read it aloud. If it sounds like a press release, rewrite it. If
   it sounds like something you'd actually say on stage or in conversation, keep it
