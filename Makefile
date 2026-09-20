# SBPF v0 everywhere, not just in the test path. Anchor 1.2 defaults to v3 and
# LiteSVM 0.10 cannot load a v3 ELF, but the deploy script also calls anchor
# build, so leaving the two paths on different arches means whichever ran last
# wins and the other one breaks. v0 deploys and runs fine on every cluster.
export ANCHOR_BUILD_SBF_ARCH ?= v0

# One command per thing a judge or a contributor needs. `make test` from a
# fresh clone is the contract.

.PHONY: help build test localnet setup fmt clean indexer indexer-test indexer-seed require-anchor

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

build: require-anchor ## Build the on-chain program (SBPF v0)
	@rm -f target/deploy/veto.so
	anchor build --ignore-keys

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
