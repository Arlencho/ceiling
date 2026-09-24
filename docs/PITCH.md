# Pitch

The claim is the recorded refusal. When a rule fails, the transfer is never executed and no tokens move. The decline is a record, with a reason and the override that would clear it, on a phone, with the key in Seed Vault. The prior art is the table in [PLAN.md](PLAN.md).

## Sixty seconds

> The agent tries to pay. The amount is over the ceiling you set. It does not pay. The chain records why, in one line, with the override that would clear it.
>
> The decline is a record. A blocked overspend elsewhere is a failed transaction: no artifact, no reason, no trail.
>
> A rule opened in the app keeps its budget in its own token account, derived from the owner. The mandate is the delegate on that account. The key never leaves Seed Vault. One human, several agents, one rule each. A ruleset is written once and reused on the next agent. This one is on a phone.
>
> The demo pays a bill repriced by a public index, on Solana devnet, in our token, to our counterparty. It buys no electricity. On the rule the video quotes (cap 100, per-payment maximum 0.5, mandate `CZw2prUtN6Kb5kmiGKYDk4zaVmFxdJ2RPj4MTujgR39g`) the chain shows decisions from 2026-09-20 20:57:50 UTC through 2026-09-21 22:00:11 UTC: three payments under the ceiling and six refusals over it. One refusal is taken off the phone and verified against the chain from somewhere else.
>
> That record is the point. A worst case fixed in advance, every payment made against it, and every refusal the agent submitted. AP2 standardised the record of a yes. This is the missing half.

## Position

A rule opened in the app keeps the cap in a token account derived from the owner with the seed `veto-rule-<mandate id>`. The mandate PDA is the SPL delegate on that account. Close rule returns the remaining balance and the rent. The key never leaves Seed Vault. One human, several agents, one rule each. A ruleset is written once and reused on the next agent. The other designs are infrastructure. This one is on a phone.

The names are the table in [PLAN.md](PLAN.md): Squads v4 spending limits, SPL `approve` / delegate, LazorKit, SolAgent Pay, Oculus, x402, AP2, and Seed Vault.

SolAgent Pay's README says an overspend "is not a policy violation logged after the fact, it is an impossible transaction." They escrow into a vault. The funds here stay in an account the owner controls, under a delegate, and the decline is recorded.

AP2 mandates are the record of a yes, held off chain as the merchant's evidence. The word mandate, in this repository, is the on-chain rule. Oculus reimburses a breach from a USDC reserve after the fact. This declines before money moves, and the decline is recorded.

A burner wallet is simple. It has no payee restriction and no expiry, and revocation means moving the funds. A refused attempt is a silent error in a log. A third party cannot check the limits that were agreed in advance and every payment made against them. The comparison is in [PROBLEM.md](PROBLEM.md).

## The demo

An agent pays a bill repriced by a public index, unattended, against an on-chain rule. The index is the Nordic day-ahead electricity spot: public, no key, independently verifiable against the same URL. The price is the only input we do not control, which is why the refusal counts. The demo buys no electricity. Solana devnet. Our token. Our counterparty.

The recording uses the decisions already on mandate `CZw2prUtN6Kb5kmiGKYDk4zaVmFxdJ2RPj4MTujgR39g`: opened 2026-09-20 20:57:50 UTC, last signature 2026-09-21 22:00:11 UTC, three paid and six refused. That rule's source is the owner's associated token account. A later rule on the same account holds the delegate, so a new charge against the quoted rule is reason 5 when the bill is over the per-payment limit and reason 7 when it is inside the limits once the delegation is withdrawn. The paid and refused rows already on it are unchanged.

[scripts/devnet-setup.sh](../scripts/devnet-setup.sh) creates the mint, mints the supply the watcher spends, and creates the counterparty token account. [tools/produce.ts](../tools/produce.ts) mints further supply of that same mint into a separate source account. When the rule allows the bill, the program executes an SPL transfer of that token to the account we created. The counterparty is a terminal we run. Public addresses are in [DEVNET.md](DEVNET.md).

## Connect your agent

On an active rule the rule screen shows Connect your agent: the fields of one JSON block, Copy all, and a QR of that same block. A rule that is not active shows "This rule is not active, so there is no config to hand an agent." and does not show Copy all or the QR. `loadAgentConfig` reads the block. `VetoAgent.fromConfig` checks it against the chain. The program id is the one bundled with the SDK unless the caller passes a different id in code. Decimals are checked on the mint account. The cluster name is checked against the endpoint's genesis hash. A connection passed to `fromConfig` is the endpoint. The example is [sdk/examples/pay-once.ts](../sdk/examples/pay-once.ts).

## Limits

The SPL delegated amount is the ceiling underneath the rule. The rule narrows it by per-payment maximum, expiry, and a single allowed payee. The owner revokes in one signature, and can also revoke the delegation directly without this program. The program notices that revocation and reports it. The worst case is the number the owner already agreed to lose.

On a rule opened in the app, that delegation sits on the rule's own token account. Revoking one rule does not clear another rule's account. On a shared source, SPL allows one delegate, and revoke clears that delegate.

There is no program ledger entry for a charge the agent never submits. The record is every decision the agent submits. No payment happens without a record, and no submitted attempt is judged by the agent instead of by the chain. The terminal shows payments that arrived. It has no view of a charge the agent never submitted.

No model is involved. The numbers are typed or taken from a template, and the why is a fixed sentence per reason code. The program stores the purpose string as written and does not evaluate it. The agent operator can supply a model-agnostic purpose check of a charge against that on-chain purpose: on a decline the agent submits no charge and records a memo the app and the SDK show as Agent declined (advisory), the program still enforces every number, whoever runs the agent can skip the check, and verify does not treat that memo as a program refusal.

A complete record of every payment made under this authority, a worst case fixed in advance by the rule, and every refusal the agent surfaced. The rule is the prior claim. The decisions are the evidence. Neither is worth anything alone.

## Where this goes

Software is starting to spend money on its own. Every control built so far answers one question: can this agent pay? The record answers the next one: should anyone let it?

A payment ledger shows that an agent had money. The decisions under a rule show what it did at the edge: the limit agreed in advance, every payment made against it, and every refusal it submitted, each one checkable against the chain by someone who trusts neither the owner nor us. That is the history a merchant, an auditor or a counterparty needs before letting software spend unattended. The other designs stop the overspend and keep no such history.

The purpose check is the first step past the numbers. The chain enforces amount, payee and time. The agent can already record why it declined a charge that fits the numbers but not the purpose. The direction is a mandate that governs what the money is for, with the chain keeping the evidence either way.

People built trust with a payment history. Agents will build it with a history of refusals, and that history starts on chain.

## Scope through the deadline

Submissions close October 8, 2026 ([Solana Mobile announcement](https://solanamobile.com/blog/clock-in-the-solana-mobile-hackathon)).

One rule type. A delegate on a token account the owner controls. Several rules, one agent each. A ruleset written once and applied to the next agent. One pay path. One refusal path with a reason and an override hint. A Decisions screen. Connect your agent on an active rule. An export anyone can re-read from the chain, including after the mandate account is closed. The quoted rule's history is the span above. No DeFi zoo, no marketplace, no W3C verifiable credential, no signing ceremony, no verifier service.

## Words

The words the entry does not use are in [internal/WORDS.md](internal/WORDS.md).
