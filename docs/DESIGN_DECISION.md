# The design we are building

Decided 2026-09-21 after four independent proposals against `DESIGN_BRIEF.md`, one each from
four vendors. All four are kept on their branches as the record: `design/claude.html`,
`design/kimi.html`, `design/grok.html`, `design/codex.html`.

## The base is the Claude proposal

Its information design and its writing are the best of the four.

- **The rule reads as a sentence.** "Pay 6i99...PdCG up to 0.5 at a time and 100 in total, until
  19 Dec 2026, for SE3 home charging." A stranger understands the product from that line alone,
  which is exactly what the brief asked for.
- **Every paid row says "Paid within rule".** The rule is stated on the ordinary rows too, so a
  refusal reads as the same system reaching a different answer rather than as an exception.
- **The refusal is parchment on a dark ground**, which is already the state inversion that the
  Grok proposal made explicit. It gets the effect more quietly.

## Three changes taken from the others

**1. The tab bar comes from the Codex proposal.** Icons with labels and a clear active state,
instead of a text-only row. Structure only: the Codex yellow on olive reads as caution, which is
the one association this product cannot afford, so the bar is rendered in the Claude palette.

**2. Three tabs, not four, because one of the four was a verb.** Share is not a destination.
Nobody thinks "go to Share", they think "show someone this decision". Tabs are places; actions
belong on the object they act on.

The same reasoning removes Revoke from the bar: revoking is an action on a rule.

| Tab | Answers | Actions inside it |
|---|---|---|
| Overview | What happened while I was not looking | open a decision |
| Rules | What is this agent allowed to do | switch rule, edit, revoke |
| Decisions | Every answer the chain gave | share, open in explorer |

**3. The line on the refusal card comes from the Codex proposal:** "Your rule held. No payment
made." Six words that say a decline is a success, which is the hardest thing in this product to
communicate.

## Constraints that come with the decision

- **Share must be a primary action**, full width on the decision, and reachable from the refusal
  card on Overview. It is the thing that makes the claim real, and burying it in an overflow menu
  would hide the product behind a chevron.
- **A refusal is never styled as an error.** No red, no warning iconography, no de-emphasis. This
  is the rule the whole brief was written around.
- **It has to survive phone width.** The Claude proposal was drawn wide and is serif heavy and
  text dense. On a six inch screen, filmed at arm's length, that density may not read. Render at
  true phone width before any React Native is written, and if the body copy goes thin, keep the
  structure and the words and raise the weight.
- **Several rules at once**, per the brief addendum and issue 47. A person holding a mint bot cap,
  a quest farm cap and a charging cap, each with its own agent key.
