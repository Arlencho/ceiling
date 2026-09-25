# The design we are building

Decided 2026-09-21 after four proposals against `DESIGN_BRIEF.md`. They are Proposal A, Proposal B, Proposal C, and Proposal D in this note. This file does not list branch names.

On 2026-09-25 the app added a fourth tab, Agents. Share and Revoke are still actions, not tabs. A paid row's title names the payee. The notification title is still "Paid within rule". Grades, plaques, the week in review, the track record card, renewal, the quiet note, the widgets, and Hold are described in the root README. The notes below are the 2026-09-21 decision, kept as written.

## The base is Proposal A

Its information design and its writing are the base the app follows.

- **The rule reads as a sentence.** "Pay 6i99...PdCG up to 0.5 at a time and 100 in total, until
  19 Dec 2026, for SE3 home charging." A stranger understands the product from that line alone,
  which is exactly what the brief asked for.
- **Every paid row says "Paid within rule".** The rule is stated on the ordinary rows too, so a
  refusal reads as the same system reaching a different answer rather than as an exception.
- **The refusal is parchment on a dark ground**, which is the state inversion Proposal C stated outright. Proposal A gets the effect more quietly.

## Three changes taken from the others

**1. The tab bar comes from Proposal B.** Icons with labels and a clear active state,
instead of a text-only row. Structure only: Proposal B's yellow on olive reads as caution, which is
the one association this product cannot afford, so the bar is rendered in the Proposal A palette.

**2. Three tabs, not four, because one of the four was a verb.** Share is not a destination.
Nobody thinks "go to Share", they think "show someone this decision". Tabs are places; actions
belong on the object they act on.

The same reasoning removes Revoke from the bar: revoking is an action on a rule.

| Tab | Answers | Actions inside it |
|---|---|---|
| Overview | What happened while I was not looking | open a decision |
| Rules | What is this agent allowed to do | switch rule, edit, revoke |
| Decisions | Every answer the chain gave | share, open in explorer |

**3. The line on the refusal card comes from Proposal B:** "Your rule held. No payment
made." Six words that say a decline is a success, which is the hardest thing in this product to
communicate.

Proposal D did not supply a piece named in the screens below.

## Constraints that come with the decision

- **Share must be a primary action**, full width on the decision, and reachable from the refusal
  card on Overview. It is the thing that makes the claim real, and burying it in an overflow menu
  would hide the product behind a chevron.
- **A refusal is never styled as an error.** No red, no warning iconography, no de-emphasis. This
  is the rule the whole brief was written around.
- **It has to survive phone width.** Proposal A was drawn wide and is serif heavy and
  text dense. On a six inch screen, filmed at arm's length, that density may not read. Render at
  true phone width before any React Native is written, and if the body copy goes thin, keep the
  structure and the words and raise the weight.
- **Several rules at once**, per the brief addendum and issue 47. A person holding a mint bot cap,
  a quest farm cap and a charging cap, each with its own agent key.

## Sharing is one decision or the whole population

Added 2026-09-21. Single-decision share is the demo beat. Bulk export is the product.

The claim this entry rests on is that anyone can check the complete record of what an agent was
allowed to do and every answer the chain gave. An auditor testing a sample, or an insurer pricing
a risk, does not want one decision. They want all of them, and the value is precisely that it is
the whole population rather than a sample. Shipping only single-decision share would demonstrate
the idea while withholding the thing that makes it worth anything.

So the share surface offers three scopes:

| Scope | For |
|---|---|
| This decision | Showing someone one answer, the demo beat |
| A date range | A period under review, a month, a week |
| Everything under this rule | The complete population, which is the whole argument |

And two shapes, because the two readers are different:

- **CSV**, so it opens in a spreadsheet and a person can sort and total it.
- **JSON**, the documented decision record schema in `docs/DECISION_RECORD.md`, so another
  system can consume it and `tools/verify.ts` can re-check it against the chain.

Every exported row carries its own transaction signature. A bulk export that cannot be verified
row by row is just a spreadsheet, and a spreadsheet is what everyone already has. The export is
worth something only because each line can be taken back to the chain independently.

Say the honest limit on the export itself, not only in the pitch: the record is complete over
payments, never over attempts.
