# petems Personal Preferences

> These are conventions in the `git-commit-and-push-petems` skill that go beyond
> (or differ from) what the Conventional Commits spec, the Sparkbox article,
> and the Karma convention prescribe. They reflect Peter's personal workflow
> preferences.

## Commit title: 50-character limit

The standard specs use **70 characters** (Karma) or impose no explicit limit
(Conventional Commits, Sparkbox). Peter enforces a stricter **50-character max**
for the entire title line, aligning with the classic "50/72 rule" from Tim Pope's
git commit message guidelines.

## Body bullets use `*` not `-`

None of the three reference specs mandate a particular bullet character. Peter
requires `*` (asterisk) bullet points in the commit body rather than `-` (dash)
or prose paragraphs.

## Body line width: 72 characters

Karma says 80 characters for body lines. Conventional Commits and Sparkbox do
not specify a wrap width. Peter uses **72 characters**, again following the
classic 50/72 rule.

## "Link relevant references" guideline

The specs mention issue references in the **footer** (`Closes #123`). Peter
additionally asks for links to broader references (PRs, docs, design docs) in
the **body** itself for non-trivial changes, not just issue shorthand in the
footer.

## Co-Authored-By trailer for Claude

None of the specs mention AI co-authorship. Peter's skill requires a
`Co-Authored-By: Claude <noreply@anthropic.com>` trailer on every commit made
with Claude's assistance.

## HEREDOC commit technique

The skill mandates passing the commit message through a bash HEREDOC
(`cat <<'EOF' ... EOF`) to preserve multi-line formatting. This is a practical
workflow preference, not something any of the specs address.

## Semantic branch naming

Branch naming (`<type>/#<issueNumber>-<alias>`) is entirely outside the scope of
all three commit message specs. This is a petems convention for keeping branch
names consistent with commit types.

## Imperative mood: origin note

The imperative mood rule is not a petems-specific preference (Karma and Conventional
Commits both require it), but it is worth noting where the convention originates.
It comes from Git's own `Documentation/SubmittingPatches`:

> Describe your changes in imperative mood, e.g. "make xyzzy do frotz" instead
> of "[This patch] makes xyzzy do frotz" or "[I] changed xyzzy to do frotz",
> as if you are giving orders to the codebase to change its behavior.

Source: <https://git.kernel.org/pub/scm/git/git.git/tree/Documentation/SubmittingPatches?h=v2.36.1#n181>

## Scope is "optional but encouraged"

Conventional Commits and Karma both treat scope as purely optional. Peter nudges
toward including it ("optional but encouraged").

## Explicit `git status` verification after commit

The skill requires running `git status` after every commit to confirm success.
This is a workflow safeguard not mentioned in any of the specs.

## Upstream detection before push

The push step checks for a tracking branch and conditionally uses `-u`. This is
a workflow preference for safe pushing, unrelated to commit message format.
