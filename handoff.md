## Built

Rebuilt the Expo app as a console for one owner governing several agents.

- Three tabs only: Overview, Rules, Decisions. Icon plus label, 12px labels, spruce/bone palette from `design/merged.html`. Share is an action on a decision. Revoke is an action on a rule.
- Overview answers which rule, then spent/paid/refused/time left, then today. Rules lists every on-chain mandate with purpose, spent against cap, time left, agent key, payee, and state. Switching one changes Overview and Decisions.
- Rule detail: the rule as a sentence, fields, two-key copy, revoke. Limits cannot change on chain; "edit" saves a new ruleset version on the phone.
- Decisions: "Paid within rule" on ordinary rows. Refusal is inverted bone on ink: "Your rule held. No payment made." plus the override. Payee lives on the rule, not as an unlabelled address on the row. A signature is labelled as a transaction.
- Decision detail: Share is the full-width primary action.
- Rulesets (issue 59): authored on the phone, name plus version, apply to a new agent is one action. Identity and version are stamped into purpose (`[slug vN]`), which is on chain and immutable. Copy never claims the ruleset file is on chain.
- Export (phone half of 51): this decision, a date range, or everything under this rule; CSV columns identical to `tools/bulk.ts`; JSON is the documented record or bulk envelope with `completeness=payments`.
- Help from every tab, three screens: what a rule is, why a refusal is recorded and the two keys, what export proves including the honest limit.
- Rate-limited RPC read is its own state (`rate-limited`) and says so.

## Decisions

- Consume export shape from `tools/bulk.ts` (CSV columns, completeness note, JSON envelope) rather than importing Node indexer into Expo. Rows come from the on-chain ring plus paginated ledger signatures. Unsigned rows are omitted, not invented.
- Payee belongs on the rule (issue 56). Decision rows never show an unlabelled address.
- App half of 55 only: detect 429, surface `rate-limited`, retry 500/1000/2000ms. Watcher endpoint is out of charter.
- New mandate always mints a fresh agent keypair so each rule has its own agent.
- No red in the theme. Form and RPC errors use bone/olive.

## Do not repeat

- Do not reorder `app/index.js` polyfill imports.
- Do not hardcode an RPC url or program id.
- Do not invent rows, prices, or kWh on decision copy. The design HTML numbers are a visual spec, not fixtures.
- Do not claim a ruleset is on chain. Only the purpose stamp is.
- Do not add an iOS or web target, or run EAS / interactive login.
- Do not touch `programs/veto/src`.
- `npm ci` and checks must run from `app/` (lockfile lives there).

## Evidence

- `cd app && npx tsc --noEmit` : clean
- `cd app && npm test` : 63 pass, 0 fail
- `cd app && npx expo lint` : clean
- `cd app && npx expo config --type public` : Android only, `com.veto.app`, extra RPC/program id empty (from env, not hardcoded), splash/icon `#0F1A16`

## Open questions

- Live Seeker / MWA open-mandate and share sheet still need a device. Headless checks do not replace that.
- Bulk export beyond the ring depends on `getSignaturesForAddress` on this RPC. A wrapped week on a history-poor cluster will be incomplete, and the file still says completeness=payments.

## Next hint

PR against `main` on `feat/app-fleet-console`. Issues 47, 51, 52, 55, 56, 59 stay open for QA.
