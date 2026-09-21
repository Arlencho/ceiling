//! The spine of the product, asserted rather than claimed.
//!
//! A refused charge must produce a transaction that SUCCEEDS, moves no tokens,
//! and leaves a ledger entry naming the reason and the override that would have
//! cleared it, all in the same confirmed transaction. If `charge` ever becomes
//! an error on refusal, these tests fail, because an error rolls back the
//! ledger write and the refusal stops existing.
//!
//! LiteSVM 0.10 cannot load an SBPFv3 ELF. Build the program with
//! `ANCHOR_BUILD_SBF_ARCH=v0 anchor build --ignore-keys` before `cargo test`.

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{
            instruction::Instruction, program_pack::Pack, system_instruction, system_program,
        },
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    anchor_spl::token::spl_token,
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    veto::state::{
        Entry, Ledger, Mandate, KIND_PAID, KIND_REFUSED, REASON_OK, REASON_OVER_PER_TX_MAX,
    },
};

const DECIMALS: u8 = 6;
const ONE: u64 = 1_000_000;
const FAR_FUTURE: i64 = 4_000_000_000;
const PROGRAM_BYTES: &[u8] =
    include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/veto.so"));

struct World {
    svm: LiteSVM,
    owner: Keypair,
    agent: Keypair,
    merchant_owner: Pubkey,
    mint: Pubkey,
    source: Pubkey,
    destination: Pubkey,
    mandate: Pubkey,
    ledger: Pubkey,
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
        .map(|meta| {
            // LiteSVM rejects a second tx with the same signature as AlreadyProcessed.
            // A retry of the same charge after an override is the same instruction
            // bytes, so the blockhash has to change between sends.
            svm.expire_blockhash();
            meta
        })
        .map_err(|e| format!("{:?}\n{}", e.err, e.meta.pretty_logs()))
}

fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    signers: &[&Keypair],
    ixs: &[Instruction],
) -> Result<(), String> {
    send_meta(svm, payer, signers, ixs).map(|_| ())
}

fn token_balance(svm: &LiteSVM, account: &Pubkey) -> u64 {
    let raw = svm.get_account(account).expect("token account exists");
    spl_token::state::Account::unpack(&raw.data)
        .expect("unpacks")
        .amount
}

fn read_mandate(svm: &LiteSVM, key: &Pubkey) -> Mandate {
    let raw = svm.get_account(key).expect("mandate exists");
    let mut data: &[u8] = &raw.data;
    Mandate::try_deserialize(&mut data).expect("mandate deserializes")
}

/// The most recently written ring entry.
fn last_entry(svm: &LiteSVM, key: &Pubkey) -> Entry {
    let raw = svm.get_account(key).expect("ledger exists");
    let ledger: &Ledger = bytemuck::from_bytes(&raw.data[8..8 + std::mem::size_of::<Ledger>()]);
    let capacity = ledger.entries.len();
    let last = (ledger.head as usize + capacity - 1) % capacity;
    ledger.entries[last]
}

fn create_token_account(
    svm: &mut LiteSVM,
    payer: &Keypair,
    mint: &Pubkey,
    owner: &Pubkey,
) -> Pubkey {
    let account = Keypair::new();
    let ixs = [
        system_instruction::create_account(
            &payer.pubkey(),
            &account.pubkey(),
            10_000_000,
            spl_token::state::Account::LEN as u64,
            &spl_token::ID,
        ),
        spl_token::instruction::initialize_account3(&spl_token::ID, &account.pubkey(), mint, owner)
            .expect("initialize_account3"),
    ];
    send(svm, payer, &[payer, &account], &ixs).expect("create token account");
    account.pubkey()
}

fn load_program(svm: &mut LiteSVM) {
    // ELF64 e_flags sits at offset 48. Anchor 1.2 defaults to SBPFv3 (e_flags = 3);
    // LiteSVM 0.10 rejects that ELF as Instruction(InvalidAccountData).
    let e_flags = u32::from_le_bytes(PROGRAM_BYTES[48..52].try_into().expect("elf e_flags"));
    assert!(
        e_flags == 0,
        "target/deploy/veto.so is SBPFv{e_flags}; LiteSVM 0.10 can only load v0. Rebuild with: ANCHOR_BUILD_SBF_ARCH=v0 anchor build --ignore-keys"
    );
    svm.add_program(veto::id(), PROGRAM_BYTES)
        .unwrap_or_else(|e| panic!("program loads: {e:?}"));
}

/// Owner holds 1000 tokens. A mandate is open for 500 total, 100 per payment,
/// payable only to the merchant.
fn setup() -> World {
    setup_with(500 * ONE, 100 * ONE)
}

fn setup_with(cap: u64, per_tx_max: u64) -> World {
    let mut svm = LiteSVM::new();
    load_program(&mut svm);

    let owner = Keypair::new();
    let agent = Keypair::new();
    let merchant_owner = Pubkey::new_unique();
    svm.airdrop(&owner.pubkey(), 100_000_000_000).unwrap();
    svm.airdrop(&agent.pubkey(), 100_000_000_000).unwrap();

    // Mint.
    let mint_kp = Keypair::new();
    let mint = mint_kp.pubkey();
    let ixs = [
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
    ];
    send(&mut svm, &owner, &[&owner, &mint_kp], &ixs).expect("create mint");

    let source = create_token_account(&mut svm, &owner, &mint, &owner.pubkey());
    let destination = create_token_account(&mut svm, &owner, &mint, &merchant_owner);

    send(
        &mut svm,
        &owner,
        &[&owner],
        &[spl_token::instruction::mint_to(
            &spl_token::ID,
            &mint,
            &source,
            &owner.pubkey(),
            &[],
            1_000 * ONE,
        )
        .expect("mint_to")],
    )
    .expect("fund owner");

    let mandate_id: u64 = 1;
    let (mandate, _) = Pubkey::find_program_address(
        &[
            b"mandate",
            owner.pubkey().as_ref(),
            &mandate_id.to_le_bytes(),
        ],
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
                per_tx_max,
                expires_at: FAR_FUTURE,
                purpose: "charging".to_string(),
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
    send(&mut svm, &owner, &[&owner], &[open]).expect("open mandate");

    World {
        svm,
        owner,
        agent,
        merchant_owner,
        mint,
        source,
        destination,
        mandate,
        ledger,
    }
}

fn charge_ix(w: &World, amount: u64, nonce: u64) -> Instruction {
    Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::Charge { amount, nonce }.data(),
        veto::accounts::Charge {
            agent: w.agent.pubkey(),
            mandate: w.mandate,
            ledger: w.ledger,
            source: w.source,
            destination: w.destination,
            mint: w.mint,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
    )
}

#[test]
fn a_charge_within_the_mandate_is_paid() {
    let mut w = setup();
    let before = token_balance(&w.svm, &w.source);

    let ix = charge_ix(&w, 50 * ONE, 1);
    let agent = w.agent.insecure_clone();
    send(&mut w.svm, &agent, &[&agent], &[ix]).expect("charge succeeds");

    assert_eq!(token_balance(&w.svm, &w.source), before - 50 * ONE);
    assert_eq!(token_balance(&w.svm, &w.destination), 50 * ONE);

    let mandate = read_mandate(&w.svm, &w.mandate);
    assert_eq!(mandate.spent, 50 * ONE);
    assert_eq!(mandate.spend_count, 1);
    assert_eq!(mandate.refusal_count, 0);
    assert_eq!(mandate.last_nonce, 1);

    let entry = last_entry(&w.svm, &w.ledger);
    assert_eq!(entry.kind, KIND_PAID);
    assert_eq!(entry.reason, REASON_OK);
    assert_eq!(entry.amount, 50 * ONE);
}

/// A 180-over-60 per-payment refusal after 50 already paid against a 500 cap.
/// Remaining is 450, so an override of 180 still clears it. The old
/// remaining=158 figure made amount exceed remaining, so the program would
/// have logged override_to_clear=0.
#[test]
fn a_180_over_60_refusal_logs_remaining_450_and_an_override_that_still_clears_it() {
    let mut w = setup_with(500 * ONE, 60 * ONE);
    let agent = w.agent.insecure_clone();

    let paid = charge_ix(&w, 50 * ONE, 1);
    send(&mut w.svm, &agent, &[&agent], &[paid]).expect("paid under the cap");

    let refused = charge_ix(&w, 180 * ONE, 2);
    let meta =
        send_meta(&mut w.svm, &agent, &[&agent], &[refused]).expect("a refusal still confirms");

    let line = meta
        .logs
        .iter()
        .find(|row| row.contains("VETO REFUSED"))
        .cloned()
        .expect("refusal log is present");
    let expected = "Program log: VETO REFUSED reason=5 (over per-payment maximum) amount=180000000 per_tx_max=60000000 remaining=450000000 override_to_clear=180000000";
    assert_eq!(line, expected);
    // Printed so the PR can paste the real output rather than a restated claim.
    println!("{line}");

    let entry = last_entry(&w.svm, &w.ledger);
    assert_eq!(entry.kind, KIND_REFUSED);
    assert_eq!(entry.reason, REASON_OVER_PER_TX_MAX);
    assert_eq!(entry.amount, 180 * ONE);
    assert_eq!(entry.suggested_override, 180 * ONE);
}

/// The line the deck, the video, the README and the phone quote. Live SE3
/// figures: cap 100000000, per_tx_max 500000, the two cheap payments that
/// landed before the refusal (446000 + 214500), amount 6232500. Remaining is
/// cap minus spent. Override is the amount because 6232500 is over 500000
/// and still under remaining.
#[test]
fn the_quoted_refusal_log_is_6232500_over_500000_and_an_override_still_clears_it() {
    const CAP: u64 = 100_000_000;
    const PER_TX_MAX: u64 = 500_000;
    const FIRST_PAID: u64 = 446_000;
    const SECOND_PAID: u64 = 214_500;
    const REFUSED: u64 = 6_232_500;

    let mut w = setup_with(CAP, PER_TX_MAX);
    let agent = w.agent.insecure_clone();

    let first = charge_ix(&w, FIRST_PAID, 1);
    send(&mut w.svm, &agent, &[&agent], &[first]).expect("first cheap payment");
    let second = charge_ix(&w, SECOND_PAID, 2);
    send(&mut w.svm, &agent, &[&agent], &[second]).expect("second cheap payment");

    let refused = charge_ix(&w, REFUSED, 3);
    let meta =
        send_meta(&mut w.svm, &agent, &[&agent], &[refused]).expect("a refusal still confirms");

    let line = meta
        .logs
        .iter()
        .find(|row| row.contains("VETO REFUSED"))
        .cloned()
        .expect("refusal log is present");
    let remaining = CAP - FIRST_PAID - SECOND_PAID;
    assert_eq!(remaining, 99_339_500);
    let expected = format!(
        "Program log: VETO REFUSED reason=5 (over per-payment maximum) amount={REFUSED} per_tx_max={PER_TX_MAX} remaining={remaining} override_to_clear={REFUSED}"
    );
    assert_eq!(line, expected);
    println!("{line}");

    let entry = last_entry(&w.svm, &w.ledger);
    assert_eq!(entry.kind, KIND_REFUSED);
    assert_eq!(entry.reason, REASON_OVER_PER_TX_MAX);
    assert_eq!(entry.amount, REFUSED);
    assert_eq!(entry.suggested_override, REFUSED);
}

/// This is the test the whole pitch rests on.
#[test]
fn a_refusal_confirms_moves_nothing_and_is_recorded_in_the_same_transaction() {
    let mut w = setup();
    let source_before = token_balance(&w.svm, &w.source);
    let destination_before = token_balance(&w.svm, &w.destination);
    let mandate_before = read_mandate(&w.svm, &w.mandate);

    // 180 is over the 100 per-payment maximum and under the 500 cap.
    let ix = charge_ix(&w, 180 * ONE, 1);
    let agent = w.agent.insecure_clone();

    // The transaction SUCCEEDS. A refusal is not an error, because an error
    // would roll back the record of it.
    send(&mut w.svm, &agent, &[&agent], &[ix]).expect("a refusal still confirms");

    // No tokens moved.
    assert_eq!(
        token_balance(&w.svm, &w.source),
        source_before,
        "source balance changed on a refusal"
    );
    assert_eq!(
        token_balance(&w.svm, &w.destination),
        destination_before,
        "merchant received funds on a refusal"
    );

    // The mandate's spend accounting is untouched, and the nonce did not
    // advance, so this charge can still be retried after an override.
    let mandate = read_mandate(&w.svm, &w.mandate);
    assert_eq!(mandate.spent, mandate_before.spent);
    assert_eq!(mandate.spend_count, mandate_before.spend_count);
    assert_eq!(mandate.last_nonce, mandate_before.last_nonce);
    assert_eq!(mandate.refusal_count, mandate_before.refusal_count + 1);

    // And the refusal exists, with a reason and a way forward.
    let entry = last_entry(&w.svm, &w.ledger);
    assert_eq!(entry.kind, KIND_REFUSED);
    assert_eq!(entry.reason, REASON_OVER_PER_TX_MAX);
    assert_eq!(entry.amount, 180 * ONE);
    assert_eq!(
        entry.suggested_override,
        180 * ONE,
        "a refusal should say what override would have cleared it"
    );
}

/// An override raises the per-payment ceiling for one nonce and nothing else.
#[test]
fn an_override_clears_the_exact_charge_it_was_granted_for() {
    let mut w = setup();
    let owner = w.owner.insecure_clone();
    let agent = w.agent.insecure_clone();

    let first = charge_ix(&w, 180 * ONE, 7);
    send(&mut w.svm, &agent, &[&agent], &[first]).expect("refusal confirms");
    assert_eq!(token_balance(&w.svm, &w.destination), 0);

    let grant = Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::GrantOverride {
            amount: 180 * ONE,
            nonce: 7,
        }
        .data(),
        veto::accounts::OwnerAction {
            owner: owner.pubkey(),
            mandate: w.mandate,
            ledger: w.ledger,
            source: w.source,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
    );
    send(&mut w.svm, &owner, &[&owner], &[grant]).expect("owner grants the override");

    let retry = charge_ix(&w, 180 * ONE, 7);
    send(&mut w.svm, &agent, &[&agent], &[retry]).expect("retry after override");
    assert_eq!(token_balance(&w.svm, &w.destination), 180 * ONE);

    // The override was one-shot: the same amount under a fresh nonce is refused again.
    let second = charge_ix(&w, 180 * ONE, 8);
    send(&mut w.svm, &agent, &[&agent], &[second]).expect("second attempt confirms");
    assert_eq!(
        token_balance(&w.svm, &w.destination),
        180 * ONE,
        "override was reusable"
    );
    assert_eq!(last_entry(&w.svm, &w.ledger).reason, REASON_OVER_PER_TX_MAX);
}

/// A mandate names one payee. Paying anyone else is refused, on the record.
#[test]
fn a_payment_to_an_unnamed_merchant_is_refused() {
    let mut w = setup();
    let owner = w.owner.insecure_clone();
    let agent = w.agent.insecure_clone();
    let stranger = create_token_account(&mut w.svm, &owner, &w.mint, &Pubkey::new_unique());

    let ix = Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::Charge {
            amount: 10 * ONE,
            nonce: 1,
        }
        .data(),
        veto::accounts::Charge {
            agent: agent.pubkey(),
            mandate: w.mandate,
            ledger: w.ledger,
            source: w.source,
            destination: stranger,
            mint: w.mint,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
    );
    send(&mut w.svm, &agent, &[&agent], &[ix]).expect("refusal confirms");

    assert_eq!(token_balance(&w.svm, &stranger), 0);
    let entry = last_entry(&w.svm, &w.ledger);
    assert_eq!(entry.kind, KIND_REFUSED);
    assert_eq!(
        entry.suggested_override, 0,
        "no override should clear a wrong payee"
    );
    let _ = w.merchant_owner;
}
