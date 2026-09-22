# Deck

Slide by slide. The app that shipped has a rule and a decision, and the fleet sits in the
existing slides. Presentation is 25% of the score and clarity of vision is one of the five
things the evaluation process names.

Ten slides. Nothing here needs a screenshot that does not exist yet, except where marked.

---

## 1. The moment

> **The agent tried to pay. It didn't.**

One screenshot, full bleed: the refusal card on the phone. It says "Your rule held. No payment
made." Then the why line from the 18:00 SE3 refusal the [README](../README.md) already links:

> Asked for 6.2325, over the 0.5 per-payment maximum. An override of 6.2325 would have cleared
> it.

Never styled as an error. That card, the explorer log on slide 6, and the verify beat in the
video are the same recorded decision. Not a second rule.

No logo slide, no team slide, no agenda. The first slide is the refusal card.

---

## 2. The two bad options

> AI can already decide what to buy. Crypto gives you two options: sign every transaction, or hand
> an agent a blank check.

Left: a wall of approval prompts. Right: a drained wallet. Thirty seconds.

---

## 3. What a rule is

Four limits, on the rule:

- **cap** the total it may ever spend
- **per-payment maximum** the largest single payment
- **expiry** after which nothing moves
- **payee** the only counterparty

One human, several agents, one rule each. A ruleset is written once and reused on the next agent.

> The key never leaves Seed Vault. Funds never leave your wallet. The agent gets authority, not
> ownership.

---

## 4. Prior art, named

These are the limits that already exist.

| | What it does |
|---|---|
| Squads v4 | Audited, formally verified spending limits |
| SPL delegate | A cap on what a delegate may pull |
| LazorKit | Session keys with on-chain roles and limits |
| SolAgent Pay | Session PDA, ceilings, allowlist, TTL |
| AP2 | Signed mandates carrying limits and validity |

> Capped agent spending on Solana is not new. An infrastructure vendor publishes a tutorial on it.
> We are not claiming it.

---

## 5. What every one of them has in common

> They all stop it. So do we.
>
> The difference is what is left behind. Everywhere else a blocked overspend is a failed
> transaction: no artifact, no reason, no trail.

Quote SolAgent Pay's own README on screen, verbatim, in their words: an overspend "is not a policy
violation logged after the fact, it is an impossible transaction."

Here the transfer is not executed. The decline is recorded.

---

## 6. We make it legible

Screenshot of an explorer showing a confirmed transaction, with the program log visible:

```
VETO REFUSED reason=5 (over per-payment maximum) amount=6232500
per_tx_max=500000 remaining=99339500 override_to_clear=6232500
```

That line is the program log on the 18:00 refusal the [README](../README.md) already links.
Amount 6.2325, per-payment maximum 0.5, remaining 99.3395 of a 100 cap, override 6.2325.
Same decision as slide 1.

> The transaction succeeded at deciding no. The payment did not happen. The balance is unchanged,
> and neither party can edit the record.
>
> The last field is the override that would have cleared the charge.

---

## 7. Why Solana Mobile

> Seed Vault is built so a human approves every signature. That is the right default, and it is
> exactly why unattended agent spend has nowhere to live on this platform.
>
> A rule is the Seed Vault-shaped answer: the key never leaves the vault, and the agent gets
> bounded authority beside it rather than a copy of the key.

---

## 8. A real week

Screenshot: the Decisions screen with multi-day history. **Needs the watcher to have been running.**

> The agent pays a bill repriced by a public index, unattended, against an on-chain rule, when
> that bill is under the ceiling. The price is the only input we do not control, which is why the
> refusal counts, and you can check it at the same URL we do.
>
> Solana devnet. Our token. Our counterparty: a terminal we run. When the rule allows the bill,
> the program executes an SPL transfer of that token to an account we created.

The index is the Nordic day-ahead spot. The mint and the counterparty account are created by
[scripts/devnet-setup.sh](../scripts/devnet-setup.sh). [tools/produce.ts](../tools/produce.ts)
mints further supply of that same mint. Addresses are in [DEVNET.md](DEVNET.md).

---

## 9. The exhaust

> A worst case fixed in advance by the rule. A complete record of every payment made against it.
> Every refusal the agent surfaced.
>
> AP2 standardised the record of a yes. This is the missing half.

Eventually that record is what lets someone underwrite agent spend, dispute a drained wallet with
a trail, or compare agents by how they behave at a limit. Nobody is buying it in 2026.

**Thirty seconds.**

---

## 10. Scope

> One rule type. Delegate, not vault. Several rules, one agent each. A ruleset written once and
> applied to the next agent. One pay path. One refusal path with a reason and an override hint.
> An export anyone can re-read from the chain. A real week of history.
>
> Shipped by Oct 8. Not a bank. Not a marketplace.

---

## Words that never appear

Checked against `docs/PITCH.md` before export:

"credential", "first ever", "nobody has", "hard fail", "fail closed", "revert", "proof of
restraint" unqualified, "every attempt", "capped budgets" as a headline claim. No em dash.

## Build notes

Screenshots needed, and the slide each belongs to: 1 the refusal card, 6 the explorer log, 8 the
Decisions screen with multi-day history. All three depend on the watcher having run, which is why
Sep 23 is the gate.
