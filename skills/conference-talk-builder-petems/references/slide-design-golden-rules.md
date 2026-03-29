# Golden Rules of Slide Design

Quick-reference guide for designing effective presentation slides. Adapted from
[The Golden Rules of Presentation Design](https://blog.thenounproject.com/the-golden-rules-of-presentation-design/)
by Jeremy Elliott (The Noun Project Blog), with supporting material from the
[companion guide](https://blog.thenounproject.com/how-to-create-presentations-that-pop-companion-guide/).

## 1. One idea per slide

Each slide should communicate a single message or takeaway. If you find yourself
adding a second bullet cluster or a "bonus" point, that is a new slide. This
reduces cognitive load and makes the talk easier to follow.

## 2. Visual hierarchy

Guide the viewer's eye to the most important element first. Use size, weight,
colour, and position to establish a clear reading order.

- Headings should be at least 50% larger than body text
- Bold key words or phrases rather than underlining or italicising
- Place the most important element where the eye lands first (top-left for
  left-to-right readers, or centre for full-bleed divider slides)

## 3. Contrast

Text and visuals must stand out from the background. Low contrast is the fastest
way to lose an audience in a dim conference room.

- Light text on dark backgrounds or dark text on light backgrounds
- Avoid red-green combinations (colour blindness)
- Avoid pure white backgrounds on projectors (they wash out and strain eyes)
- Use a contrast checker (e.g. WebAIM) to verify readability

## 4. White space

Resist the urge to fill every pixel. Generous margins and padding draw attention
to what matters and give the slide room to breathe.

- Leave at least 10-15% margin on all edges
- White space between groups of content creates natural separation
- An empty slide with one bold statement is more powerful than a packed slide

## 5. Alignment

Align elements along consistent vertical and horizontal lines. A "scattershot"
layout with text and images placed randomly is one of the biggest threats to
legibility and professional credibility.

- Use left-aligned text for body content (easier to scan than centred)
- Centre-align sparingly: title slides, dividers, single statements
- Keep images and text blocks snapped to the same grid

## 6. Repetition and consistency

Reuse the same colours, fonts, spacing, and layout patterns across all slides.
Consistency signals professionalism and helps the audience focus on content
instead of adjusting to a new layout every slide.

- Same heading size and position on every content slide
- Same accent colour for emphasis throughout
- Same icon style and line weight if using icons

## 7. Typography

Font choice affects readability more than most speakers realise, especially in
large rooms with varied seating distances.

- **Maximum 2 typefaces** per deck (one for headings, one for body)
- **Minimum 24pt** for body text, larger for headings
- Prefer **sans-serif** fonts for screen readability (e.g. Inter, Source Sans,
  Fira Sans, Roboto)
- The 30pt rule (Guy Kawasaki): if the audience cannot read it from the back
  row, the text is too small

## 8. Colour

A restrained palette looks polished. Too many colours create visual noise.

- **3-4 colours maximum**: one or two for backgrounds, two for accents/text/icons
- Pick colours that reinforce meaning (e.g. green for success, amber for warning)
- Use colour tools for palette generation: Adobe Color, Coolors, ColorSpace
- Test your palette on a projector if possible; colours shift between screens

## 9. Images and icons

Visuals should support the message, not decorate it.

- One impactful image per slide beats three mediocre ones
- Use consistent icon styles (all outline or all filled, same line weight)
- Icons can replace bullet points to reduce text density
- Always credit image sources on a references slide
- Choose images with diverse representation

## 10. Animation and transitions

Animation should serve a purpose (revealing a build, showing a sequence). If it
does not, leave it out.

- One animation per slide maximum
- Avoid flashy transitions between slides (they distract)
- Fade or appear is almost always the right choice over spin/fly/bounce

## 11. The 10-20-30 rule (Guy Kawasaki)

A useful guardrail, especially for business presentations:

- **10 slides** maximum for the core message
- **20 minutes** maximum speaking time
- **30pt** minimum font size

Conference talks often exceed 10 slides, but the spirit of the rule holds:
fewer slides with bigger text forces you to cut filler and keep only what
matters.

## Applying these rules in MARP

MARP gives you direct control over all of these through CSS and Markdown:

- Set base font sizes in the `<style>` block (see `marp-syntax.md`)
- Use section classes for consistent colour themes across slide groups
- Use `<!-- _class: lead -->` for centred, high-impact statement slides
- Use `![bg]` directives for full-bleed background images
- Keep bullet lists to 3-5 items (one idea per slide)
- Use the breadcrumb header for consistent navigation across content slides
