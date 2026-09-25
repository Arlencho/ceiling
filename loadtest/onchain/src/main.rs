//! Compute-unit load measurement for the veto program.
//!
//! What this measures: the compute units (CU) one instruction costs, recorded
//! per instruction kind and refusal reason, inside LiteSVM 0.10 running
//! single-threaded on the host. Every number in the report is a per-decision
//! cost. Nothing here is a throughput figure: there is one client, one
//! thread, and no contention, so transactions per second would say something
//! about this laptop and nothing about the program.
//!
//! Shape of the run:
//!   1. Load target/deploy/veto.so, the same SBPFv0 ELF the program tests
//!      load (built with `ANCHOR_BUILD_SBF_ARCH=v0 anchor build --ignore-keys`,
//!      which is what the root Makefile `build-test` target runs).
//!   2. Open N mandates, one per agent, each with its own funded source
//!      token account. N comes from VETO_LOADTEST_MANDATES, default 5000.
//!   3. Fire K charges against every mandate, alternating a paid shape
//!      (amount == per_tx_max) with a refused shape (amount > per_tx_max, so
//!      reason = over per-payment maximum). K comes from
//!      VETO_LOADTEST_CHARGES, default 40, so the 32-entry ledger ring wraps
//!      on every mandate and wrap CU can be compared against pre-wrap CU.
//!   4. Write loadtest/reports/cu.json and loadtest/reports/cu.md, and print
//!      the same table plus the devnet cross-check to stdout.
//!
//! Nonces increase on every charge, so no two transactions share a signature
//! and no blockhash expiry is needed between sends.

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{
            instruction::Instruction, program_pack::Pack, system_instruction, system_program,
        },
        InstructionData, ToAccountMetas,
    },
    anchor_spl::token::spl_token,
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    std::{fmt::Write as _, path::PathBuf},
};

const DECIMALS: u8 = 6;
const FAR_FUTURE: i64 = 4_000_000_000;

/// Paid shape: exactly the per-payment maximum, so it clears every rule.
const PAID_AMOUNT: u64 = 500_000;
/// Refused shape: ten times the per-payment maximum, still under the
/// remaining cap, so the reason is always over per-payment maximum (5).
const REFUSED_AMOUNT: u64 = 5_000_000;
const PER_TX_MAX: u64 = PAID_AMOUNT;

/// The CU figures recorded on devnet, printed next to the LiteSVM numbers so
/// the cross-check is visible rather than claimed.
const DEVNET_PAID_CU: u64 = 14_011;
const DEVNET_REFUSED_CU: u64 = 12_417;

/// Ring capacity, mirrored from veto::state::LEDGER_CAPACITY so the wrap
/// buckets are named in the report even if the program constant changes.
const RING_CAPACITY: u64 = 32;

const DEFAULT_MANDATES: usize = 5_000;
const DEFAULT_CHARGES: usize = 40;

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|raw| raw.parse().ok())
        .unwrap_or(default)
}

fn program_path() -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/veto.so"))
}

fn reports_dir() -> PathBuf {
    PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../reports"))
}

fn load_program(svm: &mut LiteSVM) {
    let bytes = std::fs::read(program_path()).unwrap_or_else(|e| {
        panic!(
            "cannot read {}: {e}. Build it first with: make -C .. build-test",
            program_path().display()
        )
    });
    // ELF64 e_flags sits at offset 48. Anchor 1.2 defaults to SBPFv3
    // (e_flags = 3); LiteSVM 0.10 rejects that ELF as
    // Instruction(InvalidAccountData).
    let e_flags = u32::from_le_bytes(bytes[48..52].try_into().expect("elf e_flags"));
    assert!(
        e_flags == 0,
        "target/deploy/veto.so is SBPFv{e_flags}; LiteSVM 0.10 can only load v0. Rebuild with: ANCHOR_BUILD_SBF_ARCH=v0 anchor build --ignore-keys"
    );
    svm.add_program(veto::id(), &bytes)
        .unwrap_or_else(|e| panic!("program loads: {e:?}"));
}

fn send_meta(
    svm: &mut LiteSVM,
    payer: &Keypair,
    signers: &[&Keypair],
    ixs: &[Instruction],
) -> Result<litesvm::types::TransactionMetadata, String> {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers)
        .map_err(|e| format!("{e:?}"))?;
    svm.send_transaction(tx)
        .map_err(|e| format!("{:?}\n{}", e.err, e.meta.pretty_logs()))
}

fn create_token_account_ixs(payer: &Pubkey, account: &Pubkey, mint: &Pubkey, owner: &Pubkey) -> [Instruction; 2] {
    [
        system_instruction::create_account(
            payer,
            account,
            10_000_000,
            spl_token::state::Account::LEN as u64,
            &spl_token::ID,
        ),
        spl_token::instruction::initialize_account3(&spl_token::ID, account, mint, owner)
            .expect("initialize_account3"),
    ]
}

/// One mandate and the keys needed to charge against it.
struct Rule {
    agent: Keypair,
    source: Pubkey,
    mandate: Pubkey,
    ledger: Pubkey,
}

/// CU samples for one bucket. A bucket is an instruction kind plus a refusal
/// reason, optionally split by whether the ledger ring had wrapped yet.
#[derive(Default)]
struct Bucket {
    samples: Vec<u64>,
}

struct Summary {
    count: usize,
    min: u64,
    p50: u64,
    p95: u64,
    max: u64,
    mean: f64,
}

impl Bucket {
    fn push(&mut self, cu: u64) {
        self.samples.push(cu);
    }

    fn summarize(&self) -> Summary {
        if self.samples.is_empty() {
            return Summary {
                count: 0,
                min: 0,
                p50: 0,
                p95: 0,
                max: 0,
                mean: 0.0,
            };
        }
        let mut sorted = self.samples.clone();
        sorted.sort_unstable();
        let len = sorted.len();
        let sum: u128 = sorted.iter().map(|&v| v as u128).sum();
        Summary {
            count: len,
            min: sorted[0],
            p50: sorted[(len - 1) * 50 / 100],
            p95: sorted[(len - 1) * 95 / 100],
            max: sorted[len - 1],
            mean: sum as f64 / len as f64,
        }
    }
}

/// The compute units a program reports on its own "Program <id> consumed N
/// of M compute units" log line. The veto line is the number an explorer
/// shows for a devnet transaction; for a paid charge it includes the SPL
/// token transfer CPI, so the token program's line is subtracted to get the
/// veto-only figure the devnet cross-check compares against.
fn consumed_from_logs(logs: &[String], program: &Pubkey) -> Option<u64> {
    let marker = format!("Program {program} consumed ");
    logs.iter().rev().find_map(|line| {
        line.strip_prefix(marker.as_str())
            .and_then(|rest| rest.split(' ').next())
            .and_then(|digits| digits.parse().ok())
    })
}

fn summary_json(name: &str, s: &Summary) -> String {
    format!(
        "\"{name}\": {{\"count\": {}, \"min\": {}, \"p50\": {}, \"p95\": {}, \"max\": {}, \"mean\": {:.1}}}",
        s.count, s.min, s.p50, s.p95, s.max, s.mean
    )
}

fn main() {
    let n_mandates = env_usize("VETO_LOADTEST_MANDATES", DEFAULT_MANDATES);
    let k_charges = env_usize("VETO_LOADTEST_CHARGES", DEFAULT_CHARGES);
    assert!(n_mandates > 0, "VETO_LOADTEST_MANDATES must be positive");
    assert!(k_charges > 0, "VETO_LOADTEST_CHARGES must be positive");

    println!("veto loadtest-cu: LiteSVM 0.10 single-threaded compute units per decision");
    println!("this measures cost per instruction, not throughput");
    println!("mandates (VETO_LOADTEST_MANDATES): {n_mandates}");
    println!("charges per mandate (VETO_LOADTEST_CHARGES): {k_charges}");

    let started = std::time::Instant::now();
    let mut svm = LiteSVM::new();
    load_program(&mut svm);

    // One owner, one mint, one merchant with one destination account shared by
    // every mandate. Each mandate gets its own agent and its own funded
    // source, because open_mandate delegates the source to the mandate PDA
    // and a shared source would leave only the last mandate delegated.
    let owner = Keypair::new();
    let merchant_owner = Pubkey::new_unique();
    svm.airdrop(&owner.pubkey(), 1_000_000_000_000).unwrap();

    let mint_kp = Keypair::new();
    let mint = mint_kp.pubkey();
    send_meta(
        &mut svm,
        &owner,
        &[&owner, &mint_kp],
        &[
            system_instruction::create_account(
                &owner.pubkey(),
                &mint,
                10_000_000,
                spl_token::state::Mint::LEN as u64,
                &spl_token::ID,
            ),
            spl_token::instruction::initialize_mint2(
                &spl_token::ID,
                &mint,
                &owner.pubkey(),
                None,
                DECIMALS,
            )
            .expect("initialize_mint2"),
        ],
    )
    .expect("create mint");

    let destination_kp = Keypair::new();
    let destination = destination_kp.pubkey();
    send_meta(
        &mut svm,
        &owner,
        &[&owner, &destination_kp],
        &create_token_account_ixs(&owner.pubkey(), &destination, &mint, &merchant_owner),
    )
    .expect("create destination");

    // The cap covers the paid charges with headroom, plus one full refused
    // amount, so remaining never drops below REFUSED_AMOUNT. Otherwise the
    // late refusals would log override_to_clear=0 (no override clears them),
    // which is a shorter log line and a different CU population.
    let cap = PAID_AMOUNT * (k_charges as u64 / 2 + 2) + REFUSED_AMOUNT;

    let mut open_cu = Bucket::default();
    let mut paid_cu = Bucket::default();
    let mut refused_cu = Bucket::default();
    // The veto program's own "consumed" log line, the number an explorer
    // shows on devnet. For paid charges the SPL token CPI's line is
    // subtracted, giving the veto-only figure the devnet cross-check
    // compares against.
    let mut paid_veto_net_cu = Bucket::default();
    let mut refused_veto_cu = Bucket::default();
    // Per-mandate paired wrap deltas: (post-wrap mean minus pre-wrap mean)
    // within one mandate, so the per-mandate PDA bump search cost cancels
    // out instead of polluting the comparison.
    let mut paid_wrap_deltas: Vec<f64> = Vec::with_capacity(n_mandates);
    let mut refused_wrap_deltas: Vec<f64> = Vec::with_capacity(n_mandates);
    let mut unexpected = 0usize;
    let debug_logs = std::env::var("VETO_LOADTEST_DEBUG_LOGS").is_ok();
    let trace_first = std::env::var("VETO_LOADTEST_TRACE_FIRST").is_ok();
    let mut debug_paid_done = false;
    let mut debug_refused_done = false;

    let mut rules: Vec<Rule> = Vec::with_capacity(n_mandates);
    for i in 0..n_mandates {
        let agent = Keypair::new();
        svm.airdrop(&agent.pubkey(), 10_000_000).unwrap();

        let source_kp = Keypair::new();
        let source = source_kp.pubkey();
        let create = create_token_account_ixs(&owner.pubkey(), &source, &mint, &owner.pubkey());
        let fund = spl_token::instruction::mint_to(
            &spl_token::ID,
            &mint,
            &source,
            &owner.pubkey(),
            &[],
            cap,
        )
        .expect("mint_to");
        send_meta(
            &mut svm,
            &owner,
            &[&owner, &source_kp],
            &[create[0].clone(), create[1].clone(), fund],
        )
        .expect("create and fund source");

        let mandate_id = (i + 1) as u64;
        let (mandate, _) = Pubkey::find_program_address(
            &[b"mandate", owner.pubkey().as_ref(), &mandate_id.to_le_bytes()],
            &veto::id(),
        );
        let (ledger, _) = Pubkey::find_program_address(&[b"ledger", mandate.as_ref()], &veto::id());

        let open = Instruction::new_with_bytes(
            veto::id(),
            &veto::instruction::OpenMandate {
                args: veto::OpenMandateArgs {
                    mandate_id,
                    agent: agent.pubkey(),
                    merchant: merchant_owner,
                    cap,
                    per_tx_max: PER_TX_MAX,
                    expires_at: FAR_FUTURE,
                    purpose: "loadtest".to_string(),
                },
            }
            .data(),
            veto::accounts::OpenMandate {
                owner: owner.pubkey(),
                mandate,
                ledger,
                source,
                mint,
                token_program: spl_token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let meta = send_meta(&mut svm, &owner, &[&owner], &[open]).expect("open mandate");
        open_cu.push(meta.compute_units_consumed);

        rules.push(Rule {
            agent,
            source,
            mandate,
            ledger,
        });

        if (i + 1) % 500 == 0 || i + 1 == n_mandates {
            println!("opened {}/{} mandates", i + 1, n_mandates);
        }
    }

    // Fire K charges per mandate, alternating paid and refused shapes. The
    // nonce increases on every charge, paid or not, so a refused charge is
    // never rejected for a stale nonce instead of the intended reason.
    for (i, rule) in rules.iter().enumerate() {
        // Per-mandate pre/post wrap sums, so the wrap comparison pairs a
        // mandate against itself and the per-mandate PDA bump search cost
        // (a 1500 CU step per searched bump) cancels out.
        let mut pre_paid = (0u64, 0u64);
        let mut post_paid = (0u64, 0u64);
        let mut pre_refused = (0u64, 0u64);
        let mut post_refused = (0u64, 0u64);
        for j in 0..k_charges {
            let paid_shape = j % 2 == 0;
            let amount = if paid_shape { PAID_AMOUNT } else { REFUSED_AMOUNT };
            let nonce = (j + 1) as u64;
            let ix = Instruction::new_with_bytes(
                veto::id(),
                &veto::instruction::Charge { amount, nonce }.data(),
                veto::accounts::Charge {
                    agent: rule.agent.pubkey(),
                    mandate: rule.mandate,
                    ledger: rule.ledger,
                    source: rule.source,
                    destination,
                    mint,
                    token_program: spl_token::ID,
                }
                .to_account_metas(None),
            );
            let meta = send_meta(&mut svm, &rule.agent, &[&rule.agent], &[ix])
                .expect("a charge confirms whether paid or refused");
            let cu = meta.compute_units_consumed;

            if trace_first && i == 0 {
                println!(
                    "trace: mandate 0 charge j={j} shape={} cu={cu}",
                    if paid_shape { "paid" } else { "refused" }
                );
            }

            if debug_logs && paid_shape && !debug_paid_done {
                debug_paid_done = true;
                println!("debug: full logs of the first paid charge:");
                for line in &meta.logs {
                    println!("  {line}");
                }
            }

            // Ring position of this write: the opened entry is position 0, so
            // charge j writes position j + 1. Post-wrap means the write lands
            // on a slot the ring has already used.
            let post_wrap = (j as u64 + 1) >= RING_CAPACITY;
            let was_paid = meta.logs.iter().any(|line| line.contains("VETO PAID"));
            let was_refused = meta.logs.iter().any(|line| line.contains("VETO REFUSED reason=5"));
            match (paid_shape, was_paid, was_refused) {
                (true, true, false) => {
                    paid_cu.push(cu);
                    let veto_line = consumed_from_logs(&meta.logs, &veto::id());
                    let token_line = consumed_from_logs(&meta.logs, &spl_token::ID);
                    if let (Some(veto_cu), Some(token_cu)) = (veto_line, token_line) {
                        paid_veto_net_cu.push(veto_cu.saturating_sub(token_cu));
                    }
                    let acc = if post_wrap { &mut post_paid } else { &mut pre_paid };
                    acc.0 += cu;
                    acc.1 += 1;
                }
                (false, false, true) => {
                    refused_cu.push(cu);
                    if let Some(veto_cu) = consumed_from_logs(&meta.logs, &veto::id()) {
                        refused_veto_cu.push(veto_cu);
                    }
                    if debug_logs && !debug_refused_done {
                        debug_refused_done = true;
                        println!("debug: full logs of the first refused charge:");
                        for line in &meta.logs {
                            println!("  {line}");
                        }
                    }
                    let acc = if post_wrap { &mut post_refused } else { &mut pre_refused };
                    acc.0 += cu;
                    acc.1 += 1;
                }
                _ => unexpected += 1,
            }
        }
        if pre_paid.1 > 0 && post_paid.1 > 0 {
            paid_wrap_deltas
                .push(post_paid.0 as f64 / post_paid.1 as f64 - pre_paid.0 as f64 / pre_paid.1 as f64);
        }
        if pre_refused.1 > 0 && post_refused.1 > 0 {
            refused_wrap_deltas.push(
                post_refused.0 as f64 / post_refused.1 as f64
                    - pre_refused.0 as f64 / pre_refused.1 as f64,
            );
        }
        if (i + 1) % 500 == 0 || i + 1 == n_mandates {
            println!("charged {}/{} mandates", i + 1, n_mandates);
        }
    }

    let elapsed = started.elapsed();
    let open = open_cu.summarize();
    let paid = paid_cu.summarize();
    let refused = refused_cu.summarize();
    let paid_veto_net = paid_veto_net_cu.summarize();
    let refused_veto = refused_veto_cu.summarize();

    let delta_stats = |deltas: &[f64]| -> (f64, f64) {
        if deltas.is_empty() {
            return (0.0, 0.0);
        }
        let mean = deltas.iter().sum::<f64>() / deltas.len() as f64;
        let max_abs = deltas.iter().fold(0.0f64, |acc, d| acc.max(d.abs()));
        (mean, max_abs)
    };
    let (paid_wrap_delta, paid_wrap_max_abs) = delta_stats(&paid_wrap_deltas);
    let (refused_wrap_delta, refused_wrap_max_abs) = delta_stats(&refused_wrap_deltas);
    // A decision's CU drifts by single digits as log-line digit counts change
    // with spent and remaining, so anything under 25 CU is noise, not a wrap
    // effect.
    let wrap_conclusion =
        if paid_wrap_max_abs < 25.0 && refused_wrap_max_abs < 25.0 && !paid_wrap_deltas.is_empty() {
            "ring wrap does not change compute units"
        } else {
            "WARNING: ring wrap changed compute units, investigate before quoting"
        };

    let measurement =
        "LiteSVM 0.10 single-threaded compute units per decision. Cost per instruction, not throughput.";

    let mut out = String::new();
    let _ = writeln!(out, "\n{measurement}");
    let _ = writeln!(
        out,
        "mandates={} charges_per_mandate={} total_charges={} unexpected_outcomes={}",
        n_mandates,
        k_charges,
        n_mandates * k_charges,
        unexpected
    );
    let _ = writeln!(out, "\n| instruction   | kind    | reason                   | count | min CU | p50 CU | p95 CU | max CU | mean CU |");
    let _ = writeln!(out, "| ------------- | ------- | ------------------------ | ----- | ------ | ------ | ------ | ------ | ------- |");
    let _ = writeln!(
        out,
        "| open_mandate  | opened  | ok                       | {} | {} | {} | {} | {} | {:.1} |",
        open.count, open.min, open.p50, open.p95, open.max, open.mean
    );
    let _ = writeln!(
        out,
        "| charge        | paid    | ok                       | {} | {} | {} | {} | {} | {:.1} |",
        paid.count, paid.min, paid.p50, paid.p95, paid.max, paid.mean
    );
    let _ = writeln!(
        out,
        "| charge        | refused | over per-payment maximum | {} | {} | {} | {} | {} | {:.1} |",
        refused.count, refused.min, refused.p50, refused.p95, refused.max, refused.mean
    );
    let _ = writeln!(
        out,
        "\nCU is the transaction total reported by LiteSVM. Within one kind the spread is the PDA bump search (1500 CU per searched bump), not state size: the min column is a mandate whose bumps resolved on the first try."
    );
    let _ = writeln!(
        out,
        "veto-only consumed (veto line minus the SPL token CPI line): paid p50 {} CU, refused p50 {} CU",
        paid_veto_net.p50, refused_veto.p50
    );
    let _ = writeln!(out, "\nring wrap (capacity {RING_CAPACITY}, paired per mandate):");
    let _ = writeln!(
        out,
        "  paid    mean per-mandate delta (after wrap minus before wrap) {:+.2} CU over {} mandates, largest |delta| {:.2} CU",
        paid_wrap_delta,
        paid_wrap_deltas.len(),
        paid_wrap_max_abs
    );
    let _ = writeln!(
        out,
        "  refused mean per-mandate delta (after wrap minus before wrap) {:+.2} CU over {} mandates, largest |delta| {:.2} CU",
        refused_wrap_delta,
        refused_wrap_deltas.len(),
        refused_wrap_max_abs
    );
    let _ = writeln!(out, "  {wrap_conclusion}");
    let _ = writeln!(out, "\ndevnet cross-check (veto-only CU against the devnet figures):");
    let _ = writeln!(
        out,
        "  paid    LiteSVM veto-only p50 {} CU, devnet {} CU, delta {:+}",
        paid_veto_net.p50,
        DEVNET_PAID_CU,
        paid_veto_net.p50 as i64 - DEVNET_PAID_CU as i64
    );
    let _ = writeln!(
        out,
        "  refused LiteSVM veto-only p50 {} CU, devnet {} CU, delta {:+}",
        refused_veto.p50,
        DEVNET_REFUSED_CU,
        refused_veto.p50 as i64 - DEVNET_REFUSED_CU as i64
    );
    let _ = writeln!(
        out,
        "  (transaction totals, SPL token CPI included: paid p50 {} CU, refused p50 {} CU)",
        paid.p50, refused.p50
    );
    let _ = writeln!(
        out,
        "\nrun wall time {:.1}s (setup plus measurement, informational only)",
        elapsed.as_secs_f64()
    );
    print!("{out}");

    // JSON report.
    let json = format!(
        "{{\n  \"tool\": \"veto-loadtest-cu\",\n  \"measurement\": \"{measurement}\",\n  \"simulator\": \"LiteSVM 0.10, single-threaded\",\n  \"program\": \"target/deploy/veto.so (SBPFv0, ANCHOR_BUILD_SBF_ARCH=v0 anchor build --ignore-keys)\",\n  \"mandates\": {n_mandates},\n  \"charges_per_mandate\": {k_charges},\n  \"total_charges\": {},\n  \"unexpected_outcomes\": {unexpected},\n  {},\n  {},\n  {},\n  \"veto_only_consumed\": {{\n    \"method\": \"veto program consumed log line minus the SPL token consumed log line (paid only); refused has no CPI\",\n    \"paid_p50\": {},\n    \"refused_p50\": {}\n  }},\n  \"ring_wrap\": {{\n    \"capacity\": {RING_CAPACITY},\n    \"method\": \"per-mandate paired delta of transaction-total CU, after wrap minus before wrap\",\n    \"paid_mean_delta\": {:.2},\n    \"paid_max_abs_delta\": {:.2},\n    \"paid_mandates\": {},\n    \"refused_mean_delta\": {:.2},\n    \"refused_max_abs_delta\": {:.2},\n    \"refused_mandates\": {},\n    \"conclusion\": \"{wrap_conclusion}\"\n  }},\n  \"devnet_cross_check\": {{\n    \"paid_litesvm_veto_only_p50\": {},\n    \"paid_devnet\": {DEVNET_PAID_CU},\n    \"paid_delta\": {},\n    \"refused_litesvm_veto_only_p50\": {},\n    \"refused_devnet\": {DEVNET_REFUSED_CU},\n    \"refused_delta\": {},\n    \"paid_litesvm_tx_total_p50\": {},\n    \"refused_litesvm_tx_total_p50\": {}\n  }},\n  \"run_wall_seconds\": {:.1}\n}}\n",
        n_mandates * k_charges,
        summary_json("open_mandate", &open),
        summary_json("charge_paid", &paid),
        summary_json("charge_refused_over_per_tx_max", &refused),
        paid_veto_net.p50,
        refused_veto.p50,
        paid_wrap_delta,
        paid_wrap_max_abs,
        paid_wrap_deltas.len(),
        refused_wrap_delta,
        refused_wrap_max_abs,
        refused_wrap_deltas.len(),
        paid_veto_net.p50,
        paid_veto_net.p50 as i64 - DEVNET_PAID_CU as i64,
        refused_veto.p50,
        refused_veto.p50 as i64 - DEVNET_REFUSED_CU as i64,
        paid.p50,
        refused.p50,
        elapsed.as_secs_f64(),
    );

    let dir = reports_dir();
    std::fs::create_dir_all(&dir).expect("reports dir");
    std::fs::write(dir.join("cu.json"), &json).expect("write cu.json");
    std::fs::write(
        dir.join("cu.md"),
        format!("# Compute units per decision\n\n{out}"),
    )
    .expect("write cu.md");
    println!("wrote {} and cu.md", dir.join("cu.json").display());
}
