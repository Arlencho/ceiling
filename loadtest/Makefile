# Load measurement for the veto program. This Makefile lives in loadtest/ so
# the root Makefile keeps its one-command-per-judge-contract shape.
#
# loadtest-cu builds the same SBPFv0 ELF the program tests load (the root
# Makefile build-test target, which deletes target/deploy/veto.so first so a
# stale deploy arch cannot win the relink) and then runs the standalone crate
# in loadtest/onchain. The crate is not a member of the root workspace.

.PHONY: help loadtest-cu

help: ## List targets
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make <target>\n\n"} /^[a-zA-Z0-9_-]+:.*?##/ { printf "  %-16s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

# Scale knobs, read by the binary. N mandates, K charges per mandate.
VETO_LOADTEST_MANDATES ?= 5000
VETO_LOADTEST_CHARGES ?= 40

loadtest-cu: ## Measure per-decision compute units at scale (LiteSVM, single-threaded)
	$(MAKE) -C .. build-test
	VETO_LOADTEST_MANDATES=$(VETO_LOADTEST_MANDATES) VETO_LOADTEST_CHARGES=$(VETO_LOADTEST_CHARGES) \
	  cargo run --release --manifest-path onchain/Cargo.toml
