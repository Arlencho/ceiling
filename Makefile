# Two consumers, two SBPF arches, and they are not interchangeable.
#
# LiteSVM 0.10 can only load an SBPFv3-free ELF, so the tests need v0. A
# validator rejects that same v0 binary with "Detected sbpf_version required by
# the executable which are not enabled", so a deploy needs the Anchor default.
# An earlier attempt to pin v0 everywhere deployed a program the cluster could
# not execute.
#
# Both targets write to the same target/deploy/veto.so, so each one deletes it
# first. Without that, anchor sees the artifact as up to date, relinks nothing,
# and whichever arch ran last silently wins.

# One command per thing a judge or a contributor needs. `make test` from a
# fresh clone is the contract.

.PHONY: help build test test-scripts tools-test localnet setup fmt clean indexer indexer-test indexer-seed terminal-test require-anchor e2e-devnet hold-e2e-local hold-e2e-devnet

# Two flags that are not obvious and both are required from a clean checkout.
#
# ANCHOR_BUILD_SBF_ARCH=v0 : Anchor 1.2 emits an SBPFv3 ELF by default and
#   LiteSVM 0.10 cannot load it, failing as Instruction(InvalidAccountData).
#   The tests embed target/deploy/veto.so directly, so the arch has to be v0.
#
# --ignore-keys : target/ is gitignored, so a fresh clone has no program
#   keypair. Anchor would otherwise generate one, notice it does not match
#   declare_id, and refuse. The program id in source is the real one; a local
#   build does not need to own its key.

help: ## List targets
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make <target>\n\n"} /^[a-zA-Z0-9_-]+:.*?##/ { printf "  %-16s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

# Anchor and Solana live off PATH in a non-interactive shell. Name the three
# directories to prepend rather than failing as "anchor: No such file or
# directory". Do not hardcode a home directory into the build.
require-anchor:
	@command -v anchor >/dev/null 2>&1 || { \
	  echo "anchor is not on PATH. Prepend ~/.cargo/bin, ~/.avm/bin, and ~/.local/share/solana/install/active_release/bin"; \
	  exit 1; \
	}

build: require-anchor ## Build the program for deployment (Anchor default arch)
	@rm -f target/deploy/veto.so
	anchor build --ignore-keys

build-test: require-anchor ## Build the program for LiteSVM (SBPF v0)
	@rm -f target/deploy/veto.so
	ANCHOR_BUILD_SBF_ARCH=v0 anchor build --ignore-keys

test: build-test ## Build and run the program test suite
	cargo test --manifest-path programs/veto/Cargo.toml

test-scripts: ## Run deploy-script checks that do not need a cluster
	./scripts/devnet-setup.test.sh
	./scripts/devnet-usdc.test.sh
	./scripts/ci-covers-packages.test.sh
	./scripts/ci-covers-packages-round2.test.sh
	./scripts/ci-covers-packages-round3.test.sh
	./scripts/ci-covers-packages-critic-r1.test.sh
	./scripts/ci-covers-packages-critic-r2.test.sh
	./scripts/ci-covers-packages-critic-r3.test.sh
	./scripts/ci-covers-packages-critic-r4.test.sh
	./scripts/ci-covers-packages-critic-r5.test.sh
	./scripts/ci-covers-packages-scripts-job.test.sh
	./scripts/ci-covers-packages-critic-r6.test.sh
	./scripts/ci-test-ran-proof.test.sh
	./scripts/ci-test-ran-proof-critic-r1.test.sh
	./scripts/ci-test-ran-proof-critic-r2.test.sh
	./scripts/ci-runs-typecheck.test.sh
	./scripts/docs-one-genesis.test.sh
	./scripts/gcp-verify.test.sh
	./scripts/gcp-verify-secrets.test.sh
	./scripts/deploy-watcher-cloud.test.sh
	./scripts/deploy-watcher-cloud.critic.round3.test.sh
	./scripts/watcher-silent-alert.test.sh
	./scripts/watcher-alert-round3.test.sh
	./scripts/journey158-path3.critic-r1-pr184.test.sh
	./scripts/docs-phase2-191.critic-r1-pr209.test.sh
	./scripts/docs-phase2-191.critic-r2-pr209.test.sh

# Provision a chain plus the demo fixtures. `make setup` names public devnet
# (the recorded cluster). `make localnet` names a local validator. The script
# still refuses if VETO_RPC is unset, so a direct invocation must name it.
VETO_RPC ?= https://api.devnet.solana.com
setup: ## Deploy devnet fixtures; needs the maintainer backup of keys/program.json
	VETO_RPC=$(VETO_RPC) ./scripts/devnet-setup.sh

LOCALNET_RPC ?= http://127.0.0.1:8899

localnet: ## Deploy localnet fixtures; needs the maintainer backup of keys/program.json
	VETO_RPC=$(LOCALNET_RPC) VETO_CLUSTER=localnet ./scripts/devnet-setup.sh

# Off-phone decision record (schema in docs/DECISION_RECORD.md).
# Bulk export reads the indexer library, so tools-test installs both packages.
#   make tools-test
#   cd tools && VETO_RPC=https://api.devnet.solana.com npx tsx produce.ts
#   cd tools && VETO_RPC=https://api.devnet.solana.com npx tsx export.ts --signature <tx> | VETO_RPC=https://api.devnet.solana.com npx tsx verify.ts
#   cd tools && VETO_RPC=https://api.devnet.solana.com npx tsx export.ts --mandate <addr> --format csv --out decisions.csv

tools-test: ## Typecheck and test the decision-record tools
	cd indexer && npm ci
	cd tools && npm ci
	cd tools && npm run typecheck && npm test

# Real devnet. Skipped in `npm test` unless VETO_E2E=1. Needs keys/deployer.json,
# the mint authority recorded in docs/DEVNET.md. That file is gitignored.
e2e-devnet: ## Run the devnet journey through the app and the agent SDK
	cd app && npm ci
	cd sdk && npm ci
	cd indexer && npm ci
	cd tools && npm ci
	cd app && VETO_E2E=1 \
	  VETO_RPC=https://api.devnet.solana.com \
	  EXPO_PUBLIC_VETO_RPC=https://api.devnet.solana.com \
	  EXPO_PUBLIC_VETO_PROGRAM_ID=3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV \
	  EXPO_PUBLIC_VETO_MINT=2dV6DLAUF63ugfD1sgNF8fUmQKr9pMDzeLxJGSwkMcCU \
	  EXPO_PUBLIC_VETO_EXPLORER_CLUSTER=devnet \
	  EXPO_PUBLIC_VETO_MINT_DECIMALS=6 \
	  npx tsx --experimental-test-module-mocks --test e2e/devnetJourney.test.ts

# Hold journey. Local builds the deploy arch (not the LiteSVM v0 ELF), loads
# that program into solana-test-validator, and runs sdk/e2e/holdJourney.test.ts.
# Devnet points the same test at the public cluster and does not warp the clock.
hold-e2e-local: ## Build the program, start a local validator, and run the Hold journey
	./scripts/hold-e2e.sh local

hold-e2e-devnet: ## Run the Hold journey against devnet (the clock is not warped)
	./scripts/hold-e2e.sh devnet

fmt: ## Format program sources
	cargo fmt --manifest-path programs/veto/Cargo.toml

clean: ## Remove Rust build artifacts
	cargo clean

indexer-test: ## Typecheck and test the history indexer
	cd indexer && npm ci && npm run typecheck && npm test

terminal-test: ## Typecheck and test the merchant terminal
	cd terminal && npm ci && cd ../watcher && npm ci && cd ../terminal && npm run typecheck && npm test

# declare_id in programs/veto/src/lib.rs, the Program row in docs/DEVNET.md.
VETO_PROGRAM_ID ?= 3zNp5EuQ61pR9stq4rzYsRQnjg4AYAgW8nxRje6koQmV
indexer-seed: ## Open a mandate and submit paid plus refused charges
	cd indexer && VETO_RPC=$(VETO_RPC) VETO_PROGRAM_ID=$(VETO_PROGRAM_ID) npm run seed

indexer: indexer-test ## Alias for indexer-test
