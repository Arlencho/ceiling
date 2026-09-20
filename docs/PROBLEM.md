# The problem

Written 2026-09-20, after the plan and the program, which is the wrong order. It exists because
the value proposition was inherited as a finished pitch and never interrogated. Everything here is
the answer to three questions: who has this problem this month, what do they do today instead, and
why is a burner wallet not enough.

## The claim, in one paragraph

> A complete record of every payment made under this authority, a worst case fixed in advance by
> the mandate, and every refusal the agent surfaced.
>
> The mandate is the prior claim. The ledger is the evidence. Neither is worth anything alone.

This is deliberately narrower than "proof of restraint", which does not survive a hostile reading.
A refusal on its own proves that one attempt was declined. It does not prove the agent had no other
funding path, that it did not simply avoid trying, or that the limit was restrictive at all: anyone
can set a one million ceiling and mint beautiful evidence of restraint on a five dollar charge.
Restraint only means something measured against a commitment made before the fact.

## Who has this problem this month

The person already running something automated against their own funds. A trading script, a mint
bot, an agent paying per call. Today they solve it by pasting a private key into a `.env` file or
by funding a burner wallet. They know the first is bad. They do it anyway, because the alternative
is not doing the thing.

That is a real, present, slightly embarrassing problem, and it is the honest answer to "who, this
month."

The consumer with an AI agent buying groceries is not the user yet. Being clear about that
internally matters, because it is the difference between building for a person and building for a
press release.

## Why a burner wallet is not enough

The burner is the real competitor, not Squads and not AP2. It is free, instant, universally
understood and requires no program at all. Anything in this space has to beat it explicitly.

| | Burner wallet | Mandate |
|---|---|---|
| Funding | Pre-fund, then top up forever | Nothing moves; funds stay in the main wallet under a delegate |
| Payee restriction | None. It can pay anyone | One named merchant, enforced on chain |
| Expiry | None. It is live until you empty it | A timestamp the program checks |
| Revocation | Move the funds out | One signature |
| Stops an overspend | Only by running out of money | Yes, on chain, before any transfer executes |
| Record of a decline | None. A refused attempt is a silent bot error in a log file nobody keeps | A confirmed transaction with a reason code and the override that would have cleared it |
| Third party can verify | Only that transfers happened | The limits agreed in advance, and every payment made against them |

The first four rows are conveniences. The last two are the ones that are not reproducible with a
burner at any price, and it is the reason this is a product rather than a settings screen.

## What the record is for, after the hackathon

Behind the product, not in front of it. The hero is the phone app. This is the last thirty seconds
of the pitch, not its spine, because an infrastructure pitch scores badly against mobile criteria
and insurers do not install APKs.

AP2 standardised the record of a yes: signed mandates that prove to a merchant that a human
authorised a purchase. The matching half does not exist. Nobody can show that an agent operated
inside a bound it agreed to in advance, which means nobody can underwrite agent spend, dispute
"the bot drained me" with anything, or compare agents by how they behave at a limit.

The people who eventually want that record are insurers, agent platforms, compliance functions and
counterparties. None of them are buying anything in 2026. Say so if asked, rather than implying a
market that does not exist yet.

## What we are not claiming

- **Not** a complete record of every attempt that ever existed. That is unprovable and nothing on
  chain can provide it. An agent that never submits a charge leaves no trace, here or anywhere.
- **What is** complete: every payment made under this authority, because a spend under the mandate
  has to pass through the program to happen at all. Plus every refusal the agent surfaced.
- **Not** a verifiable credential. No W3C VC profile, no signing ceremony, no verifier service by
  Oct 9. A stable documented schema and an export anyone can re-read from the chain. The word
  "credential" does not appear in the deck.
- **Not** novel in having limits on chain. That is commodity and the deck names the prior art.

## How we would know we were wrong

Worth writing down now, while it is cheap to be honest.

- If a judge asks "who uses this on a Tuesday" and the best answer is still a hypothetical, the
  consumer framing is wrong and the product is developer infrastructure wearing an app.
- If the export beat lands as a curiosity rather than an "oh", the record is not the wedge and the
  differentiator is only mobile UX on limits, which is a much weaker position.
- If someone ships a recorded on-chain refusal on mobile before Oct 9, the wedge is gone and the
  entry needs a different one.
