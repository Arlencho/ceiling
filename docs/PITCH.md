# Pitch

Rewritten 2026-09-20 after the competitive check. The claim is legible refusal, not bounded
authority. Bounded authority is crowded and partly commodity; do not claim it anywhere.

## Sixty seconds

> The agent tries to pay. The amount is over the ceiling you set. It does not pay, it tells you
> why, on chain, in one line, with the override that would clear it.
>
> Limits like that already exist. Squads, AP2, session keys. Every one of them makes an overspend
> impossible, and an impossible transaction protects your money and teaches you nothing. No
> artifact, no reason, no trail. We make the refusal legible.
>
> Funds stay in your wallet under a delegate. The key never leaves Seed Vault. Every one of those
> others is infrastructure. None of them is on a phone.
>
> The demo: one fill under the mandate. One refusal over it, on chain and readable. Seven days of
> real history from a live price feed, not three rows from this morning. Then we take one refusal
> off the phone and verify it against the chain from somewhere else.
>
> Because that record is the point. A worst case you fixed in advance, every payment made against
> it, and every refusal the agent surfaced. AP2 standardised the record of a yes. This is the
> missing half.

Lead with the moment, then disarm. Naming competitors is the memorable move, but it should not
spend the first ten seconds, which are the ones the judge is actually paying attention for.

## Words to keep out

- **"Hard fail", "revert", "fail closed".** All of them imply a rolled-back transaction, which is
  the competitor's design and the opposite of this one. Say "it declines before money moves, and
  the decline is recorded."
- **"First ever", "nobody has".** Unverifiable superlatives are where sharp judges start pulling.
  Say what is defensible: "every one of those is infrastructure, none of them is on a phone."
- **"Capped budgets", "spending limits" as the headline.** Commodity. An infrastructure vendor
  publishes a tutorial on it.
- **"Credential".** It means W3C Verifiable Credentials to anyone who knows AP2, and we are not
  building one. Say "export" or "on-chain decision record".
- **"Proof of restraint" on its own.** Too easy to fake: a one million ceiling mints beautiful
  restraint on a five dollar charge. Always pair it with the mandate, which is the commitment made
  in advance. See [PROBLEM.md](PROBLEM.md).
- **"Every attempt".** Unprovable. The complete thing is every *payment*, because a spend has to
  pass the program to happen.

## Judge Q&A

**Isn't this just a spending limit? Isn't this Squads?**
Squads and session keys make an overspend impossible. We make the refusal legible: a reason, a
trail, and the override that would clear it. Protection plus evidence, not protection instead of it.

**Isn't AP2 already "mandates"?**
AP2 mandates prove the user said yes to a merchant. They are the record of a yes, and they live off
chain as the merchant's evidence. We record the no, on chain, when an agent cannot complete under
the rules. Complementary, not a collision. We use their word on purpose.

**SolAgent Pay already does ceilings.**
Close on the numbers. Their README says an overspend "is not a policy violation logged after the
fact, it is an impossible transaction." That is the opposite thesis, stated plainly, and it is the
thing we disagree with. They also escrow into a vault PDA. We never move the funds: the mandate is
a delegate on the owner's own account. Cleaner custody, full stop.

**Why not the Oculus approach, reimbursing a breach?**
Insurance after the fact is a different product. We decline before money moves, then explain.

**Why Solana Mobile?**
Seed Vault is built so a human approves every signature. That is the right default, and it is
exactly why unattended agent spend has nowhere to live on this platform. A mandate is the Seed
Vault-shaped answer: the key never leaves the vault, and the agent gets bounded authority beside it
rather than a copy of the key. No general-purpose competitor can make that argument.

**If the agent key leaks, what is the blast radius?**
Bounded and stated up front. The SPL delegated amount is the hard ceiling underneath everything.
The mandate narrows it further by per-payment maximum, expiry and a single allowed merchant. The
owner revokes in one signature, and can also revoke the delegation directly without this program,
which the program notices and reports rather than crashing on. The worst case is the number the
owner already agreed to lose.

**Where is the record if the agent simply never submits the charge?**
There isn't one, and nothing on chain can provide one. Worth saying before someone finds it: the
ledger records every decision the agent submits, not decisions it never attempted. What it
guarantees is narrower and still worth having. No payment ever happens without a record, and no
attempt is judged by the agent instead of by the chain. The merchant also sees the missing
response, so a silently dropped charge is visible from the other side. The alternative design
records nothing in either case.

**How is the daily loop real without a fake merchant?**
The price feed is real: Nordic day-ahead electricity spot, public, no key, independently verifiable
against the same URL. The counterparty is a terminal we run, because no charge point operator takes
USDC, and we say so. What that buys is the thing that matters: the refusals happen because
electricity got expensive, not because we pressed a button. The agent has been running for a week
before the recording, so the ledger is a diary rather than three rows made that morning.

**Where does AI come in?**
Thin, and above the program only. It turns a sentence into the four mandate numbers and writes the
plain-language why from a reason code. Hard caps never depend on a model. Semantic refusal,
declining because a purchase does not match the stated purpose, ships only once the happy path is
green.

**What is the record actually good for?**
A complete record of every payment made under this authority, a worst case fixed in advance by the
mandate, and every refusal the agent surfaced. The mandate is the prior claim, the ledger is the
evidence, and neither is worth anything alone. Eventually that is what lets someone underwrite
agent spend, dispute a drained wallet with a trail, or compare agents by how they behave at a
limit. Nobody is buying that in 2026 and we say so. It is the last thirty seconds of the pitch, not
its spine.

**Isn't a burner wallet with fifty dollars in it the same thing?**
The honest competitor, and better than most of the prior art at this. It beats us on simplicity and
loses on everything that needs a prior commitment: no payee restriction, no expiry, revocation
means migrating funds, and a refused attempt is a silent error in a log nobody keeps. The row a
burner cannot reproduce at any price is a third party being able to check the limits that were
agreed in advance and every payment made against them.

**What is out of scope for the deadline?**
One mandate type. Delegate, not vault. One pay path, one refusal path with a reason and an override
hint, an audit view, an export anyone can re-read from the chain, and a real week of history from
the live feed. No DeFi zoo, no marketplace, no multi-mandate management, no verifiable-credential
profile, no signing ceremony, no verifier service.

## The prior art slide

Do not skip it. Two of the seven judges are security researchers from Ethelsec, and one is the CEO
of Helius. They know Squads, they know x402, and they may well know the three agent-wallet repos
that appeared this year. Naming the field yourself and saying exactly what is different is worth
more than any claim of novelty, and it is the opposite of what almost every hackathon deck does.

The table lives in [PLAN.md](PLAN.md).
