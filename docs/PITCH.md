# Pitch

The claim is the recorded refusal. Capped agent spending is not the claim. Squads, session
keys, and AP2 already stop an overspend. Veto stops it the same way: when a rule fails, the
transfer is never executed and no tokens move. The decline is a record, with a reason and the
override that would clear it, on a phone, with the key in Seed Vault.

## Sixty seconds

> The agent tries to pay. The amount is over the ceiling you set. It does not pay, it tells you
> why, on chain, in one line, with the override that would clear it.
>
> Limits like that already exist. Squads, AP2, session keys. Every one of them stops the overspend,
> and so does this. The difference is what is left behind. Elsewhere a blocked overspend is a
> failed transaction: no artifact, no reason, no trail. Here the decline is recorded.
>
> Funds stay in your wallet under a delegate. The key never leaves Seed Vault. One human, several
> agents, one rule each. A ruleset is written once and reused on the next agent. Those other
> designs are infrastructure. This one is on a phone.
>
> The demo: one payment under the rule. One refusal over it, on chain and readable. Seven days of
> history from a live price feed. Then one refusal taken off the phone and verified against the
> chain from somewhere else.
>
> That record is the point. A worst case fixed in advance, every payment made against it, and
> every refusal the agent surfaced. AP2 standardised the record of a yes. This is the missing half.

## Position

Funds stay in the owner's wallet under a delegate. The key never leaves Seed Vault. One human,
several agents, one rule each. A ruleset is written once and reused on the next agent. The other
designs are infrastructure. This one is on a phone.

The names are the table in [PLAN.md](PLAN.md): Squads v4 spending limits, SPL `approve` /
delegate, LazorKit, SolAgent Pay, Oculus, x402, AP2, and Seed Vault.

SolAgent Pay's README says an overspend "is not a policy violation logged after the fact, it is
an impossible transaction." They escrow into a vault. The funds here stay in the owner's account
under a delegate, and the decline is recorded.

AP2 mandates are the record of a yes, held off chain as the merchant's evidence. The word
mandate, in this repository, is the on-chain rule. Oculus reimburses a breach from a USDC
reserve after the fact. This declines before money moves, and the decline is recorded.

A burner wallet is simple. It has no payee restriction and no expiry, and revocation means
moving the funds. A refused attempt is a silent error in a log. A third party cannot check the
limits that were agreed in advance and every payment made against them. The comparison is in
[PROBLEM.md](PROBLEM.md).

## The demo

The price feed is the Nordic day-ahead electricity spot: public, no key, independently
verifiable against the same URL. The counterparty is a terminal we run, because no charge point
operator takes USDC. Refusals happen because electricity got expensive. The recording uses
history the watcher has already produced.

## Limits

The SPL delegated amount is the ceiling underneath the rule. The rule narrows it by per-payment
maximum, expiry, and a single allowed payee. The owner revokes in one signature, and can also
revoke the delegation directly without this program. The program notices that revocation and
reports it. The worst case is the number the owner already agreed to lose.

There is no record of a charge the agent never submits, and nothing on chain can provide one.
The record is every decision the agent submits. No payment happens without a record, and no
submitted attempt is judged by the agent instead of by the chain. The merchant also sees a
missing response, so a dropped charge is visible from the other side.

A model sits above the program only. It turns a sentence into the four rule numbers and writes
the plain-language why from a reason code. The caps do not depend on a model. Declining because
a purchase does not match the stated purpose waits until the charge path is in place.

A complete record of every payment made under this authority, a worst case fixed in advance by
the rule, and every refusal the agent surfaced. The rule is the prior claim. The decisions are
the evidence. Neither is worth anything alone. That record is what would let someone underwrite
agent spend, dispute a drained wallet, or compare agents by how they behave at a limit. Nobody
is buying that record in 2026.

## Scope through the deadline

One rule type. A delegate on the owner's own account. Several rules, one agent each. A ruleset
written once and applied to the next agent. One pay path. One refusal path with a reason and an
override hint. A Decisions screen. An export anyone can re-read from the chain. A week of
history from the live feed. No DeFi zoo, no marketplace, no W3C verifiable credential, no
signing ceremony, no verifier service.

## Words to keep out

[VIDEO.md](VIDEO.md) points here for the words the entry does not use.

- **"Hard fail", "revert", "fail closed".** Those names describe a rolled-back transaction. The line to use: it declines before money moves, and the decline is recorded.
- **"First ever", "nobody has".** Say what is in front of you: the other designs are infrastructure, and this one is on a phone.
- **"Capped budgets" or "spending limits" as the headline.** Capped agent spending is not new. An infrastructure vendor publishes a tutorial on it. The headline is the recorded refusal.
- **Anything that implies the spend still happens.** "We make it legible rather than impossible" reads as if the money moves and the program only writes it down. The money does not move. The line is: everyone stops the overspend, and this record can prove it stopped.
- **"Credential".** That word means a W3C verifiable credential. Say "export" or "on-chain decision record".
- **"Proof of restraint" on its own.** A one million ceiling on a five dollar charge is a record of a five dollar charge. Pair the record with the rule agreed in advance. See [PROBLEM.md](PROBLEM.md).
- **"Every attempt".** The complete record is every payment, because a spend has to pass the program to happen, and every refusal the agent submitted.

## Prior art

The table is in [PLAN.md](PLAN.md). It names Squads v4 spending limits, SPL `approve` /
delegate, LazorKit, SolAgent Pay, Oculus, x402, AP2, and Seed Vault.
