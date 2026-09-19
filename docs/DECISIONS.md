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
