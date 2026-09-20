# Veto front-end design challenge

Produce ONE self-contained HTML file: `design/<vendor>.html` in the repo. No build step, no
external JS libraries. Google Fonts is allowed. It is a visual proposal, not production code.

## What the product is

A spending rule for AI agents, enforced by a program on Solana. A person writes one rule: how
much in total, how much per payment, until when, and to which payee. An agent can then pay inside
that rule with nobody present. When a payment breaks the rule the program does not pay, and it
RECORDS the refusal on chain with the reason and the override that would have cleared it.

Every competing product makes an overspend impossible, which leaves no trace. This one makes the
refusal legible. **The recorded no is the product.** Your design has to know that.

## The one rule you cannot break

A refusal is a success. It is the product working. It must never be styled as an error: no red, no
warning triangle, no failure iconography, no muted or de-emphasised treatment. It should read as
the most confident thing on the screen. If someone glances at your design and thinks something
went wrong, you have failed the brief.

## Audience

Judges at a Solana Mobile hackathon: the co-founder of Solana Labs, the CEO of an RPC company, two
security researchers, and Solana Mobile staff. Then Seeker phone owners. Crypto-native, mobile
first, design literate, and they see many wallets. Reference points are Phantom, Backpack, Jupiter,
Tensor. Not a banking app. Not enterprise SaaS. Not playful.

## Deliver four phone screens, side by side in one row

Phone width around 390px each, laid out horizontally so one screenshot captures the whole
direction. Label each screen. Dark is expected but not mandatory if you can defend a choice.

1. **Overview.** Opens with the state, not a list: spent against cap, how many paid, how many
   refused, time left on the rule. Then recent activity.
2. **Rules.** The rule itself: total cap, per-payment maximum, expiry, payee, purpose. Plus
   starting templates a crypto user recognises, for example capping a mint bot or a quest farm.
3. **Decisions.** Every decision, paid and refused, with the reason in plain language. A refused
   row carries the override that would have cleared it and a link to the transaction. This is the
   screen the demo lingers on. Make it the best thing you draw.
4. **Share a decision.** Taking one decision off the phone and giving it to somebody: a readable
   summary, the rule that was agreed in advance, and proof anyone can check against the chain.

## Real content, use it exactly

Rule: purpose "SE3 home charging", cap 100, per payment 0.5, expires 19 Dec 2026, payee 6i99...PdCG.
Spent 0.666 of 100. Four decisions from 20 September 2026, real prices, real devnet:
- 00:00 paid 0.446 at 0.00892 SEK per kWh
- 06:00 paid 0.2145 at 0.00429
- 12:00 paid 0.0055 at 0.00011
- 18:00 REFUSED 6.2325 at 0.12465, over per-payment maximum, an override of 6.2325 would clear it
Owner key lives in Seed Vault. Agent key holds authority and no funds.

## Do not

Do not produce the current generic dark theme: near-black, white text, grey secondary, one red
accent, everything in rounded cards of equal weight. Avoid the common AI-generated looks: a purple
to blue gradient, a lone acid-green pop on near-black, Inter or Space Grotesk chosen by default,
emoji as section markers, everything centered, identical rounded cards stacked. Take a position.
Spend boldness in one place and keep the rest quiet.

## Judged on

Whether the refusal reads as the hero. Whether a stranger understands the product from the
Decisions screen alone. Typographic hierarchy and restraint. Whether it looks like it belongs on a
Seeker in 2026. One real idea beats five safe ones.
