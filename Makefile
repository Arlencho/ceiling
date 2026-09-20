# One command per thing a judge or a contributor needs. `make test` from a
# fresh clone is the contract.

.PHONY: build test localnet setup fmt clean

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
build:
	ANCHOR_BUILD_SBF_ARCH=v0 anchor build --ignore-keys

test: build
	cargo test --manifest-path programs/veto/Cargo.toml

# Provision a chain plus the demo fixtures. Devnet by default; localnet when
# the devnet faucet is rate limiting.
setup:
	./scripts/devnet-setup.sh

LOCALNET_RPC ?= http://127.0.0.1:8899

localnet:
	VETO_RPC=$(LOCALNET_RPC) VETO_CLUSTER=localnet ./scripts/devnet-setup.sh

# Off-phone decision record (schema in docs/DECISION_RECORD.md).
#   cd tools && npm ci && npm test
#   cd tools && npx tsx produce.ts
#   cd tools && npx tsx export.ts --signature <tx> | npx tsx verify.ts

fmt:
	cargo fmt --manifest-path programs/veto/Cargo.toml

clean:
	cargo clean
