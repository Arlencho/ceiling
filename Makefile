# One command per thing a judge or a contributor needs. `make test` from a
# fresh clone is the contract.

.PHONY: help build test localnet setup fmt clean indexer indexer-test indexer-seed

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

build: ## Build the on-chain program (SBPF v0)
	ANCHOR_BUILD_SBF_ARCH=v0 anchor build --ignore-keys

test: build ## Build and run the program test suite
	cargo test --manifest-path programs/veto/Cargo.toml

# Provision a chain plus the demo fixtures. Devnet by default; localnet when
# the devnet faucet is rate limiting.
setup: ## Provision the demo cluster and token fixtures
	./scripts/devnet-setup.sh

LOCALNET_RPC ?= http://127.0.0.1:8899

localnet: ## Provision fixtures against a local validator
	VETO_RPC=$(LOCALNET_RPC) VETO_CLUSTER=localnet ./scripts/devnet-setup.sh

# Off-phone decision record (schema in docs/DECISION_RECORD.md).
#   cd tools && npm ci && npm test
#   cd tools && npx tsx produce.ts
#   cd tools && npx tsx export.ts --signature <tx> | npx tsx verify.ts

fmt: ## Format program sources
	cargo fmt --manifest-path programs/veto/Cargo.toml

clean: ## Remove Rust build artifacts
	cargo clean

indexer-test: ## Typecheck and test the history indexer
	cd indexer && npm ci && npm run typecheck && npm test

indexer-seed: ## Open a mandate and submit paid plus refused charges
	cd indexer && npm run seed

indexer: indexer-test ## Alias for indexer-test
