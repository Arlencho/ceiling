# The problem

Software is already spending from wallets people own. The person running it needs a bound
fixed before the money moves, and a record of what happened inside that bound.

A refusal on its own is one declined attempt. The bound is the mandate: a total cap, a
per-payment maximum, an expiry, and one merchant, written down before the charge. The record
is the ledger of payments and refusals under that mandate. The mandate is the prior claim.
The ledger is the evidence. Neither is worth anything alone.

## Who has it today

The person already running something automated against their own funds. A trading script, a
mint bot, an agent paying per call.

A consumer whose assistant buys groceries is not that person yet.

## What they do instead

They paste a private key into a `.env` file, or they fund a burner wallet and top it up. The
burner is free, instant, and needs no program.

| | Burner wallet | Mandate |
|---|---|---|
| Funding | Pre-fund, then top up forever | Nothing moves; funds stay in the main wallet under a delegate |
| Payee restriction | None. It can pay anyone | One named merchant, enforced on chain |
| Expiry | None. It is live until you empty it | A timestamp the program checks |
| Revocation | Move the funds out | One signature |
| Stops an overspend | Only by running out of money | Yes, on chain, before any transfer executes |
| Record of a decline | None. A refused attempt is a silent bot error in a log file nobody keeps | A confirmed transaction with a reason code and the override that would have cleared it |
| Third party can verify | Only that transfers happened | The limits agreed in advance, and every payment made against them |

A third party can check the limits that were agreed in advance, and every payment made against
them. A burner wallet cannot show that.

## What Veto does about it

Veto is that mandate on Solana, and the record of the decisions under it.

The owner sets the four limits and a purpose string. The purpose is stored on chain as written.
Funds stay in the owner's wallet. The mandate account is an SPL delegate on that wallet. The
owner key stays in Seed Vault and is reached through Mobile Wallet Adapter. A separate agent
key can submit a charge. It cannot change a limit, change the merchant, extend the expiry, or
move funds outside the mandate.

When a charge is inside the limits, the program pays the merchant and writes the payment. When
a charge breaks a limit, the transfer instruction is not executed, no tokens move, and the
program writes a refusal: a reason code, and the override that would have cleared that one
payment. The instruction returns success, so the write is kept. The owner can allow that one
payment with an override. The override is a ledger entry, it applies to one nonce, and it
cannot raise the total cap. The owner can revoke the mandate in one signature, or revoke the
SPL delegation directly.

A decision can be exported and checked against the chain from another machine. The schema is
[DECISION_RECORD.md](DECISION_RECORD.md).

## What this does not claim

The record is every payment made under the mandate, and every refusal the agent submitted. A
charge the agent never submitted leaves no entry, and nothing on chain can record one. A
refusal is one declined attempt against the mandate. It does not show that the agent had no
other funding path, or that the ceiling was tight: a one million ceiling on a five dollar
charge is a record of a five dollar charge.

The export is the documented schema. Anyone can re-read it from the chain. It is not a W3C
verifiable credential. There is no signing ceremony and no verifier service.

Capped agent spending on chain is not new. The prior art is named in the [README](../README.md).

Insurers, agent platforms, compliance functions, and counterparties are the people who would
use a record like this to underwrite agent spend, to dispute a drained wallet, or to compare
agents at a limit. Nobody is buying that record in 2026.

## How we would know this was wrong

Three outcomes would show the claim does not hold.

- If the person using this on a Tuesday is still a hypothetical, the consumer framing is wrong
  and the product is developer infrastructure wearing an app.
- If the export lands as a curiosity, the record is not the wedge and the differentiator is only
  mobile UX on limits, which is a much weaker position.
- If someone else ships a recorded on-chain refusal on mobile before 2026-10-09, that wedge is
  gone and the entry needs a different one.
