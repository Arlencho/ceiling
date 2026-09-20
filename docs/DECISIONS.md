# Decisions

Append-only. Each entry states the decision, the reason, and what would reverse it.

## 2026-09-20: enter Clock In as a standalone project

Standalone repo, no coupling to any existing product. The hackathon requires the project to have
started within three months of the Sep 8 launch date, and a fresh repo removes any argument about
that. It also removes an external approval dependency from the critical path.

Reversed by: nothing. The deadline is Oct 9.

## 2026-09-20: the rule is enforced on chain, not on a server

An Anchor program owns the mandate and decides every charge. A server-side policy engine would
have been faster to build, but then the refusal is our word rather than a verifiable fact, and the
refusal is the entire product.

Reversed by: the SPL delegate mechanism failing on devnet in a way we cannot work around, in which
case the fallback is a vault PDA that holds the funds. Same enforcement, weaker custody story.

## 2026-09-20: a refusal returns Ok and writes a ledger entry

The `charge` instruction never returns an error when it declines. Returning an error would roll
back the account writes, so the refusal would leave no on-chain trace and the demo would be an
absence rather than an artifact. Declining therefore transfers nothing, writes a ledger entry with
a reason code, and returns Ok. The transaction confirms and the balance is unchanged.

Reversed by: nothing. This is the product.

## 2026-09-20: funds stay in the user's wallet

The mandate PDA is an SPL delegate on the user's own token account, not a vault holding the money.
The agent holds a separate hot key with authority and no spending power of its own. The owner key
stays in Seed Vault and is reached through Mobile Wallet Adapter.

Reversed by: the delegate path proving unworkable, per the entry above.

## 2026-09-20: the claim is legible refusal, not bounded authority

A competitive check found that capped on-chain agent budgets are commodity: Squads v4 ships
audited and formally verified spending limits, LazorKit ships session keys with on-chain roles and
limits, AP2 standardised signed mandates carrying limits and validity windows, and an
infrastructure vendor publishes a tutorial on capped on-chain agent budgets. Three GitHub projects
built the same session-PDA shape this year.

The closest of them, SolAgent Pay, states outright that an overspend "is not a policy violation
logged after the fact, it is an impossible transaction". That is the opposite thesis and it is what
we differentiate against. An impossible transaction leaves no artifact, no reason and no trail.

So the claim is narrowed and sharpened: the refusal is legible. A recorded no, a reason, and the
override that would clear it, on a phone, with the key in Seed Vault.

Reversed by: nothing found so far. If someone ships a recorded on-chain refusal on mobile before
Oct 9, the entry needs a different wedge.

## 2026-09-20: the offer feed is Nordic day-ahead electricity spot

The agent pays for charging when power is under the owner's ceiling. Verified 2026-09-20: the
endpoint returns HTTP 200 with no authentication at 15-minute resolution.

A DEX price feed was rejected. A bot buying a dip is a trading app, which is the crowded category
the brief contrasts with, and a token purchase is a trade rather than a purchase, so a refusal
loses its force.

The price is real and independently verifiable. The counterparty is a terminal we run, because no
charge point operator accepts USDC, and the README and video say so. The property this buys is
that refusals are caused by the real price crossing the ceiling rather than by staging.

Reversed by: the endpoint becoming unavailable, in which case any public feed with genuinely moving
prices for a recognisable purchase substitutes.

## 2026-09-20: the program is frozen

It compiles, it enforces four limits on chain, it has nine reason codes and a recorded refusal.
Competing with the prior art on policy surface is a losing race and it is not the wedge. One
addition only: the refusal states the override that would have cleared it, which no prior art does.

Every remaining day goes to the watcher, the feed and the phone. Innovation is banked; UX and
presentation are half the score and have not started.

Reversed by: a defect found in the security pass.

## 2026-09-20: the energy feed stays, and the Seeker answer is mandate templates

Owner review asked for the demo scenario to become something a Seeker owner would actually set
(airdrop bot budget, mint sniper ceiling, quest-farm spend), described as a scenario-line change
with the same code. Taken literally that is not possible, and the reason matters.

The scenario and the feed are coupled. The watcher pays for charging because it is watching a real
electricity price. Relabelling those same rows as an airdrop bot budget would make the numbers
fiction, which breaks the honest-data rule and is exactly the misleading-materials ground in T&C 15.

The obvious substitution does not work either. A Solana-native feed with genuinely moving prices
is priority fees, but a priority fee is not a transfer to a payee, so it cannot pass through a
mandate that enforces a merchant allowlist. Every other Seeker-native purchase is either a fixed
price (a mint), a trade (a swap, which was already rejected), or metered API usage we would have to
simulate anyway.

So, decided:

1. **The feed stays** Nordic day-ahead electricity spot. It is the only candidate with real moving
   prices for a real purchase, and it is what makes refusals happen because the world moved.
2. **The watcher is written against a `PriceFeed` interface** with the energy source as the first
   implementation, so swapping costs an afternoon rather than a rewrite if this is revisited.
3. **The Seeker answer is delivered as mandate templates in the app, not as fabricated history.**
   The mandate creation screen offers shapes a Seeker owner recognises: cap a mint bot, cap a
   quest-farm spend, cap an agent's weekly outgoings. Offering a template is honest; it claims no
   data. Only the energy mandate has real history behind it, and only that one appears in the
   ledger.

This gives the Tuesday answer in the surface a judge actually looks at, at the cost of one screen
rather than an integration, and without a single invented row.

Reversed by: the owner preferring a different feed, in which case the interface makes it cheap; or
finding a Seeker-native purchase with a real public moving price and a real payee, which would be
strictly better and should replace the energy source outright.

## 2026-09-20: the decision record is JSON anyone can re-read from the chain

The off-phone beat is a documented schema (`docs/DECISION_RECORD.md`) plus two node tools:
`tools/export.ts` writes one decision, `tools/verify.ts` re-fetches the cluster and prints
CONFIRMED or REJECTED. No signing ceremony, no hosted verifier, no W3C VC envelope. The
transaction signature is not stored in the ledger account; export recovers it from cluster
history. The program is unchanged: fields the chain does not hold are listed in the doc
instead of being added to the program.

Reversed by: a third party that will not talk to an RPC, in which case a signed envelope
becomes the product and this export stays the source it wraps.
