# Local validator load benchmark

Requires Node 22, npm, Anchor and solana-test-validator on PATH. From the repository root:

```sh
make -C loadtest validator
make -C loadtest validator ARGS=--smoke
N=200 A=50 W=16 DURATION_SECONDS=60 make -C loadtest validator
```

`N` is the rules per shape, `A` the number of generated agents, `W` the concurrent sender loops, and `DURATION_SECONDS` the submission window per shape. Defaults are 200, 50, 16 and 60. Smoke fixes N=10 and duration=10 seconds per shape, defaults A=10 and retains W=16. At most min(N,W) transactions are in flight: a rule stays locked until its previous send completes to preserve nonce order. Rules rotate across senders and agents. If A>N, only N agents can have a rule.

`VETO_RPC` defaults to `http://127.0.0.1:18899`. Only plain HTTP localhost or 127.0.0.1 endpoints are accepted, and localhost is normalized to 127.0.0.1. Redirects are refused. The harness starts its own validator on a fresh temporary ledger, checks RPC readiness and program executability, and terminates only its own child on completion, error, SIGINT or SIGTERM. Occupied RPC, websocket or faucet ports cause refusal. The faucet uses RPC port + 2. No wallet files or external cluster are used.

If `target/deploy/veto.so` is missing, the script runs the root `make build` with `ANCHOR_BUILD_SBF_ARCH` unset. This follows the Makefile's deploy recipe, including `--ignore-keys`. The `make build-test` v0 artifact is for LiteSVM and is rejected by the current validator. If a v0 artifact already exists, run `make build` first. No program sources are edited.

Each shape gets fresh rules and independent funded source token accounts. The distinct shape uses one merchant token account per rule; the shared shape uses one merchant token account across every rule. Each sender has its own funded fee payer. Agents sign but are read-only, so sharing an agent does not create a global writable fee-payer bottleneck. Every charge pays one token base unit. Setup and funding are outside the measured window.

Confirmed TPS counts confirmations observed inside the fixed window divided by its configured duration. In-flight sends drain after the window, bounded by a 30-second confirmation timeout and 10-second RPC request timeout. Total confirmations and latency percentiles include that drain, whose elapsed time is reported separately. Latency starts immediately before submission and includes serialization, RPC sending and polling to confirmed commitment at 50 ms intervals. It excludes instruction construction, signing and blockhash retrieval. Preflight and RPC retries are disabled for measured sends. Failure counts include submission errors, transaction errors and confirmation timeouts; timeouts have unknown on-chain outcomes. Confirmation can succeed for an application refusal, so the harness also verifies destination token totals against confirmed charges and exits unsuccessfully on a mismatch, zero confirmations or any failures.

Reports overwrite `loadtest/reports/validator.json` and `validator.md`. JSON is an array with one compact shape record on each physical line; each Markdown line is a standalone shape record. Each carries machine details, validator version, source commit, dirty state, binary SHA-256 and duration. A sample run from an uncommitted implementation records its base commit and `dirty=true`. Both are labelled **laptop lower bound**: the local validator, client, token accounting, confirmation polling and concurrency ceiling all constrain these figures. The short smoke sample is a harness check, not a network capacity estimate. No mainnet throughput claim follows from it.

```sh
cd loadtest/onchain/validator
npm ci
npm run typecheck
npm test
```
