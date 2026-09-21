# Deck

Slide by slide, written 2026-09-20 so M5 is a build job rather than a writing job. Aligned
2026-09-21 to the app that shipped: rule and decision, the fleet folded into existing slides,
scope as it is now. Presentation is 25% of the score and clarity of vision is one of the five
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

No logo slide, no team slide, no agenda. The first thing a judge sees is the product doing the one
thing nothing else does.

---

## 2. The two bad options

> AI can already decide what to buy. Crypto gives you two options: sign every transaction, or hand
> an agent a blank check.

Left: a wall of approval prompts. Right: a drained wallet. This is thirty seconds, not a market
analysis.

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

**Do not skip this slide.** Two of the seven judges are security researchers and one runs an RPC
company. They know this landscape. Naming it first is worth more than any claim of novelty, and
almost no hackathon deck does it.

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
> transaction: no artifact, no reason, no trail, nothing an auditor could ever look at.

Quote SolAgent Pay's own README on screen, verbatim, in their words: an overspend "is not a policy
violation logged after the fact, it is an impossible transaction."

They are right that it should be impossible, and it is impossible here too. What they treat as the
end of the story is where this one starts: they are choosing to leave nothing behind, and saying so
in their own words is far more persuasive than asserting our side of it.

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
> And it tells you what would have worked. No prior art does anything but decline.

---

## 7. Why Solana Mobile

> Seed Vault is built so a human approves every signature. That is the right default, and it is
> exactly why unattended agent spend has nowhere to live on this platform.
>
> A rule is the Seed Vault-shaped answer: the key never leaves the vault, and the agent gets
> bounded authority beside it rather than a copy of the key.

Squads cannot make this argument. AP2 cannot. It is the only "why here" that is not
interchangeable, and it is the reason this is a phone product and not another README.

---

## 8. A real week, not a staged morning

Screenshot: the Decisions screen with multi-day history. **Needs the watcher to have been running.**

> The agent watches a public electricity price feed and pays for charging under the ceiling. The
> price is real and you can check it at the same URL we do. The merchant terminal is ours, because
> no charge point takes USDC, and we say so.
>
> Which means the refusals happened because power got expensive, not because we pressed a button
> on camera.

Say the honesty boundary out loud. It converts the obvious objection into a credibility moment.

---

## 9. The exhaust

> A worst case fixed in advance by the rule. A complete record of every payment made against it.
> Every refusal the agent surfaced.
>
> AP2 standardised the record of a yes. This is the missing half.

Eventually that record is what lets someone underwrite agent spend, dispute a drained wallet with
a trail, or compare agents by how they behave at a limit. Nobody is buying it in 2026 and we say
so.

**Thirty seconds. This slide never becomes the spine.**

---

## 10. Scope, honestly

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
