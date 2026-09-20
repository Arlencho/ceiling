//! Adversarial suite for docs/SECURITY_REVIEW.md.
//!
//! Every test here is an attack that was actually run against the compiled
//! program, not a reading of the source. Tests named `claim_*` assert a
//! property the README or the program doc promises, and must keep passing.
//! Tests named `finding_*` pin down behaviour the review flagged; each one
//! carries the finding number it documents, and is expected to be inverted
//! by whichever PR fixes that finding.
//!
//! Build the program first, as for the other suite:
//! `ANCHOR_BUILD_SBF_ARCH=v0 anchor build --ignore-keys`, or `make test`.

use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{
            instruction::Instruction, program_pack::Pack, system_instruction, system_program,
        },
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    anchor_spl::token::spl_token,
    litesvm::LiteSVM,
    solana_account::Account,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    veto::state::*,
};

const DECIMALS: u8 = 6;
const ONE: u64 = 1_000_000;
const FAR_FUTURE: i64 = 4_000_000_000;
const OWNER_FUNDS: u64 = 1_000 * ONE;
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

struct Limits {
    cap: u64,
    per_tx_max: u64,
    expires_at: i64,
    freeze_authority: bool,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            cap: 500 * ONE,
            per_tx_max: 100 * ONE,
            expires_at: FAR_FUTURE,
            freeze_authority: false,
        }
    }
}

fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    signers: &[&Keypair],
    ixs: &[Instruction],
) -> Result<(), String> {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers)
        .map_err(|e| format!("{e:?}"))?;
    svm.send_transaction(tx)
        .map(|_| svm.expire_blockhash())
        .map_err(|e| format!("{:?}\n{}", e.err, e.meta.pretty_logs()))
}

fn token_account(svm: &LiteSVM, key: &Pubkey) -> spl_token::state::Account {
    let raw = svm.get_account(key).expect("token account exists");
    spl_token::state::Account::unpack(&raw.data).expect("unpacks")
}

fn balance(svm: &LiteSVM, key: &Pubkey) -> u64 {
    token_account(svm, key).amount
}

fn read_mandate(svm: &LiteSVM, key: &Pubkey) -> Mandate {
    let raw = svm.get_account(key).expect("mandate exists");
    let mut data: &[u8] = &raw.data;
    Mandate::try_deserialize(&mut data).expect("mandate deserializes")
}

fn read_ledger(svm: &LiteSVM, key: &Pubkey) -> Ledger {
    let raw = svm.get_account(key).expect("ledger exists");
    *bytemuck::from_bytes::<Ledger>(&raw.data[8..8 + std::mem::size_of::<Ledger>()])
}

fn last_entry(svm: &LiteSVM, key: &Pubkey) -> Entry {
    let ledger = read_ledger(svm, key);
    let last = (ledger.head as usize + LEDGER_CAPACITY - 1) % LEDGER_CAPACITY;
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
            .unwrap(),
    ];
    send(svm, payer, &[payer, &account], &ixs).expect("create token account");
    account.pubkey()
}

fn pdas(owner: &Pubkey, mandate_id: u64) -> (Pubkey, Pubkey) {
    let (mandate, _) = Pubkey::find_program_address(
        &[b"mandate", owner.as_ref(), &mandate_id.to_le_bytes()],
        &veto::id(),
    );
    let (ledger, _) = Pubkey::find_program_address(&[b"ledger", mandate.as_ref()], &veto::id());
    (mandate, ledger)
}

fn open_ix(
    owner: &Pubkey,
    mandate_id: u64,
    agent: &Pubkey,
    merchant: &Pubkey,
    source: &Pubkey,
    mint: &Pubkey,
    limits: &Limits,
    purpose: &str,
) -> Instruction {
    let (mandate, ledger) = pdas(owner, mandate_id);
    Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::OpenMandate {
            args: veto::OpenMandateArgs {
                mandate_id,
                agent: *agent,
                merchant: *merchant,
                cap: limits.cap,
                per_tx_max: limits.per_tx_max,
                expires_at: limits.expires_at,
                purpose: purpose.to_string(),
            },
        }
        .data(),
        veto::accounts::OpenMandate {
            owner: *owner,
            mandate,
            ledger,
            source: *source,
            mint: *mint,
            token_program: spl_token::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn setup_with(limits: Limits) -> World {
    let mut svm = LiteSVM::new();
    let e_flags = u32::from_le_bytes(PROGRAM_BYTES[48..52].try_into().unwrap());
    assert!(
        e_flags == 0,
        "veto.so must be SBPF v0 for LiteSVM 0.10; run make build"
    );
    svm.add_program(veto::id(), PROGRAM_BYTES)
        .expect("program loads");

    let owner = Keypair::new();
    let agent = Keypair::new();
    let merchant_owner = Pubkey::new_unique();
    svm.airdrop(&owner.pubkey(), 100_000_000_000).unwrap();
    svm.airdrop(&agent.pubkey(), 100_000_000_000).unwrap();

    let mint_kp = Keypair::new();
    let mint = mint_kp.pubkey();
    let freeze = if limits.freeze_authority {
        Some(&owner.pubkey())
    } else {
        None
    };
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
            freeze,
            DECIMALS,
        )
        .unwrap(),
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
            OWNER_FUNDS,
        )
        .unwrap()],
    )
    .expect("fund owner");

    let (mandate, ledger) = pdas(&owner.pubkey(), 1);
    let open = open_ix(
        &owner.pubkey(),
        1,
        &agent.pubkey(),
        &merchant_owner,
        &source,
        &mint,
        &limits,
        "charging",
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

fn setup() -> World {
    setup_with(Limits::default())
}

fn charge_ix_for(
    w: &World,
    agent: &Pubkey,
    mandate: &Pubkey,
    ledger: &Pubkey,
    source: &Pubkey,
    destination: &Pubkey,
    amount: u64,
    nonce: u64,
) -> Instruction {
    Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::Charge { amount, nonce }.data(),
        veto::accounts::Charge {
            agent: *agent,
            mandate: *mandate,
            ledger: *ledger,
            source: *source,
            destination: *destination,
            mint: w.mint,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
    )
}

fn charge_ix(w: &World, amount: u64, nonce: u64) -> Instruction {
    charge_ix_for(
        w,
        &w.agent.pubkey(),
        &w.mandate,
        &w.ledger,
        &w.source,
        &w.destination,
        amount,
        nonce,
    )
}

fn charge(w: &mut World, amount: u64, nonce: u64) -> Result<(), String> {
    let ix = charge_ix(w, amount, nonce);
    let agent = w.agent.insecure_clone();
    send(&mut w.svm, &agent, &[&agent], &[ix])
}

fn owner_action_ix(w: &World, signer: &Pubkey, data: Vec<u8>) -> Instruction {
    Instruction::new_with_bytes(
        veto::id(),
        &data,
        veto::accounts::OwnerAction {
            owner: *signer,
            mandate: w.mandate,
            ledger: w.ledger,
            source: w.source,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
    )
}

fn grant_override(w: &mut World, signer: &Keypair, amount: u64, nonce: u64) -> Result<(), String> {
    let ix = owner_action_ix(
        w,
        &signer.pubkey(),
        veto::instruction::GrantOverride { amount, nonce }.data(),
    );
    send(&mut w.svm, signer, &[signer], &[ix])
}

fn revoke(w: &mut World, signer: &Keypair) -> Result<(), String> {
    let ix = owner_action_ix(
        w,
        &signer.pubkey(),
        veto::instruction::RevokeMandate {}.data(),
    );
    send(&mut w.svm, signer, &[signer], &[ix])
}

fn close(w: &mut World, signer: &Keypair) -> Result<(), String> {
    let ix = Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::CloseMandate {}.data(),
        veto::accounts::CloseMandate {
            owner: signer.pubkey(),
            mandate: w.mandate,
            ledger: w.ledger,
        }
        .to_account_metas(None),
    );
    send(&mut w.svm, signer, &[signer], &[ix])
}

fn set_clock(w: &mut World, unix_timestamp: i64) {
    let mut clock: Clock = w.svm.get_sysvar();
    clock.unix_timestamp = unix_timestamp;
    w.svm.set_sysvar(&clock);
}

fn assert_err_contains(result: Result<(), String>, needle: &str) {
    match result {
        Ok(()) => panic!("expected an error containing {needle:?}, transaction succeeded"),
        Err(e) => assert!(
            e.contains(needle),
            "expected {needle:?} in error, got:\n{e}"
        ),
    }
}

// ---------------------------------------------------------------------------
// Authority: every widening instruction needs the owner; charge needs the agent.
// ---------------------------------------------------------------------------

#[test]
fn claim_the_agent_cannot_grant_an_override_revoke_or_close() {
    let mut w = setup();
    let agent = w.agent.insecure_clone();
    let before = read_mandate(&w.svm, &w.mandate);

    assert_err_contains(grant_override(&mut w, &agent, 180 * ONE, 7), "NotTheOwner");
    assert_err_contains(revoke(&mut w, &agent), "NotTheOwner");
    assert_err_contains(close(&mut w, &agent), "NotTheOwner");

    let after = read_mandate(&w.svm, &w.mandate);
    assert_eq!(after.override_nonce, before.override_nonce);
    assert_eq!(after.status, STATUS_ACTIVE);
}

#[test]
fn claim_neither_a_stranger_nor_the_owner_can_charge() {
    let mut w = setup();
    let stranger = Keypair::new();
    w.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    let ix = charge_ix_for(
        &w,
        &stranger.pubkey(),
        &w.mandate,
        &w.ledger,
        &w.source,
        &w.destination,
        10 * ONE,
        1,
    );
    assert_err_contains(
        send(&mut w.svm, &stranger, &[&stranger], &[ix]),
        "NotTheAgent",
    );

    let owner = w.owner.insecure_clone();
    let ix = charge_ix_for(
        &w,
        &owner.pubkey(),
        &w.mandate,
        &w.ledger,
        &w.source,
        &w.destination,
        10 * ONE,
        1,
    );
    assert_err_contains(send(&mut w.svm, &owner, &[&owner], &[ix]), "NotTheAgent");

    assert_eq!(balance(&w.svm, &w.destination), 0);
    assert_eq!(
        read_ledger(&w.svm, &w.ledger).total,
        1,
        "a rejected caller must not write the ledger"
    );
}

#[test]
fn claim_open_mandate_refuses_to_name_the_owner_as_agent_or_borrow_another_source() {
    let mut w = setup();
    let owner = w.owner.insecure_clone();
    let victim_source = w.source;

    // The owner may not be the agent.
    let ix = open_ix(
        &owner.pubkey(),
        2,
        &owner.pubkey(),
        &w.merchant_owner,
        &w.source,
        &w.mint,
        &Limits::default(),
        "x",
    );
    assert_err_contains(
        send(&mut w.svm, &owner, &[&owner], &[ix]),
        "AgentMustNotBeOwner",
    );

    // An attacker cannot open a mandate over a source they do not own.
    let attacker = Keypair::new();
    w.svm.airdrop(&attacker.pubkey(), 10_000_000_000).unwrap();
    let ix = open_ix(
        &attacker.pubkey(),
        1,
        &w.agent.pubkey(),
        &w.merchant_owner,
        &victim_source,
        &w.mint,
        &Limits::default(),
        "x",
    );
    assert_err_contains(
        send(&mut w.svm, &attacker, &[&attacker], &[ix]),
        "SourceNotOwnedByOwner",
    );
}

// ---------------------------------------------------------------------------
// Account substitution: mandate, ledger, type cosplay.
// ---------------------------------------------------------------------------

#[test]
fn claim_an_attackers_own_mandate_cannot_reach_the_victims_source_or_ledger() {
    let mut w = setup();
    let attacker = Keypair::new();
    let attacker_agent = Keypair::new();
    w.svm.airdrop(&attacker.pubkey(), 10_000_000_000).unwrap();
    w.svm
        .airdrop(&attacker_agent.pubkey(), 10_000_000_000)
        .unwrap();

    // Attacker opens a perfectly valid mandate over their own (empty) source.
    let attacker_source = create_token_account(&mut w.svm, &attacker, &w.mint, &attacker.pubkey());
    let ix = open_ix(
        &attacker.pubkey(),
        1,
        &attacker_agent.pubkey(),
        &w.merchant_owner,
        &attacker_source,
        &w.mint,
        &Limits::default(),
        "x",
    );
    send(&mut w.svm, &attacker, &[&attacker], &[ix]).expect("attacker opens own mandate");
    let (a_mandate, a_ledger) = pdas(&attacker.pubkey(), 1);

    // Point it at the victim's source: has_one = source rejects.
    let ix = charge_ix_for(
        &w,
        &attacker_agent.pubkey(),
        &a_mandate,
        &a_ledger,
        &w.source,
        &w.destination,
        10 * ONE,
        1,
    );
    assert_err_contains(
        send(&mut w.svm, &attacker_agent, &[&attacker_agent], &[ix]),
        "SourceMismatch",
    );

    // Point it at the victim's ledger: seeds reject.
    let ix = charge_ix_for(
        &w,
        &attacker_agent.pubkey(),
        &a_mandate,
        &w.ledger,
        &attacker_source,
        &w.destination,
        10 * ONE,
        1,
    );
    assert_err_contains(
        send(&mut w.svm, &attacker_agent, &[&attacker_agent], &[ix]),
        "ConstraintSeeds",
    );

    assert_eq!(balance(&w.svm, &w.source), OWNER_FUNDS);
    assert_eq!(read_ledger(&w.svm, &w.ledger).total, 1);
}

/// Forge a Mandate the program did not write. On a real cluster this is
/// impossible (only the program can write accounts it owns), so this is a
/// defence-in-depth check of the re-derivation in `charge`: the injected
/// account carries the victim's owner, id and bump but sits at another address.
#[test]
fn claim_a_program_owned_forgery_at_the_wrong_address_fails_rederivation() {
    let mut w = setup();
    let attacker_agent = Keypair::new();
    w.svm
        .airdrop(&attacker_agent.pubkey(), 10_000_000_000)
        .unwrap();

    let real = w.svm.get_account(&w.mandate).unwrap();
    let mut forged = read_mandate(&w.svm, &w.mandate);
    forged.agent = attacker_agent.pubkey();
    let mut data = Vec::new();
    anchor_lang::AccountSerialize::try_serialize(&forged, &mut data).unwrap();
    data.resize(real.data.len(), 0);

    let forged_addr = Pubkey::new_unique();
    w.svm
        .set_account(
            forged_addr,
            Account {
                lamports: real.lamports,
                data,
                owner: veto::id(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    let (forged_ledger, _) =
        Pubkey::find_program_address(&[b"ledger", forged_addr.as_ref()], &veto::id());
    let real_ledger = w.svm.get_account(&w.ledger).unwrap();
    w.svm
        .set_account(
            forged_ledger,
            Account {
                lamports: real_ledger.lamports,
                data: real_ledger.data,
                owner: veto::id(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();

    let ix = charge_ix_for(
        &w,
        &attacker_agent.pubkey(),
        &forged_addr,
        &forged_ledger,
        &w.source,
        &w.destination,
        10 * ONE,
        1,
    );
    assert_err_contains(
        send(&mut w.svm, &attacker_agent, &[&attacker_agent], &[ix]),
        "InvalidMandatePda",
    );
    assert_eq!(balance(&w.svm, &w.source), OWNER_FUNDS);
}

/// Same forgery, but placed at the PDA its own fields derive to, so the
/// re-derivation passes. The SPL delegate is then the wall: the victim's source
/// is delegated to the victim's mandate, not to this address.
#[test]
fn claim_a_forgery_at_its_own_pda_is_still_not_the_delegate_of_the_victims_source() {
    let mut w = setup();
    let attacker = Keypair::new();
    let attacker_agent = Keypair::new();
    w.svm
        .airdrop(&attacker_agent.pubkey(), 10_000_000_000)
        .unwrap();

    let (forged_addr, bump) = Pubkey::find_program_address(
        &[b"mandate", attacker.pubkey().as_ref(), &99u64.to_le_bytes()],
        &veto::id(),
    );
    let real = w.svm.get_account(&w.mandate).unwrap();
    let mut forged = read_mandate(&w.svm, &w.mandate);
    forged.owner = attacker.pubkey();
    forged.mandate_id = 99;
    forged.bump = bump;
    forged.agent = attacker_agent.pubkey();
    // source, mint, merchant stay the victim's.
    let mut data = Vec::new();
    anchor_lang::AccountSerialize::try_serialize(&forged, &mut data).unwrap();
    data.resize(real.data.len(), 0);
    w.svm
        .set_account(
            forged_addr,
            Account {
                lamports: real.lamports,
                data,
                owner: veto::id(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
    let (forged_ledger, _) =
        Pubkey::find_program_address(&[b"ledger", forged_addr.as_ref()], &veto::id());
    let real_ledger = w.svm.get_account(&w.ledger).unwrap();
    w.svm
        .set_account(
            forged_ledger,
            Account {
                lamports: real_ledger.lamports,
                data: real_ledger.data,
                owner: veto::id(),
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();

    let ix = charge_ix_for(
        &w,
        &attacker_agent.pubkey(),
        &forged_addr,
        &forged_ledger,
        &w.source,
        &w.destination,
        10 * ONE,
        1,
    );
    send(&mut w.svm, &attacker_agent, &[&attacker_agent], &[ix]).expect("confirms as a refusal");
    assert_eq!(
        last_entry(&w.svm, &forged_ledger).reason,
        REASON_DELEGATE_MISSING
    );
    assert_eq!(
        balance(&w.svm, &w.source),
        OWNER_FUNDS,
        "forged mandate moved funds"
    );
}

#[test]
fn claim_a_ledger_of_another_mandate_and_a_ledger_posing_as_a_mandate_are_rejected() {
    let mut w = setup();
    let owner = w.owner.insecure_clone();
    let ix = open_ix(
        &owner.pubkey(),
        2,
        &w.agent.pubkey(),
        &w.merchant_owner,
        &w.source,
        &w.mint,
        &Limits::default(),
        "second",
    );
    send(&mut w.svm, &owner, &[&owner], &[ix]).expect("second mandate");
    let (_, ledger2) = pdas(&owner.pubkey(), 2);

    let ix = charge_ix_for(
        &w,
        &w.agent.pubkey(),
        &w.mandate,
        &ledger2,
        &w.source,
        &w.destination,
        10 * ONE,
        1,
    );
    let agent = w.agent.insecure_clone();
    assert_err_contains(
        send(&mut w.svm, &agent, &[&agent], &[ix]),
        "ConstraintSeeds",
    );

    let ix = charge_ix_for(
        &w,
        &w.agent.pubkey(),
        &w.ledger,
        &w.ledger,
        &w.source,
        &w.destination,
        10 * ONE,
        1,
    );
    assert_err_contains(
        send(&mut w.svm, &agent, &[&agent], &[ix]),
        "AccountDiscriminatorMismatch",
    );
}

// ---------------------------------------------------------------------------
// Arithmetic.
// ---------------------------------------------------------------------------

#[test]
fn claim_a_charge_that_would_overflow_spent_is_refused_as_over_cap_not_wrapped() {
    let mut w = setup_with(Limits {
        cap: u64::MAX,
        per_tx_max: u64::MAX,
        ..Limits::default()
    });
    charge(&mut w, 50 * ONE, 1).expect("paid");
    assert_eq!(read_mandate(&w.svm, &w.mandate).spent, 50 * ONE);

    charge(&mut w, u64::MAX, 2).expect("refusal confirms");
    assert_eq!(last_entry(&w.svm, &w.ledger).reason, REASON_OVER_CAP);
    charge(&mut w, u64::MAX - 50 * ONE + 1, 2).expect("refusal confirms");
    assert_eq!(last_entry(&w.svm, &w.ledger).reason, REASON_OVER_CAP);

    // Exactly fills the cap arithmetically; fails on funds, never on a wrap.
    charge(&mut w, u64::MAX - 50 * ONE, 2).expect("refusal confirms");
    assert_eq!(
        last_entry(&w.svm, &w.ledger).reason,
        REASON_INSUFFICIENT_FUNDS
    );

    let m = read_mandate(&w.svm, &w.mandate);
    assert_eq!(m.spent, 50 * ONE);
    assert_eq!(m.remaining(), u64::MAX - 50 * ONE);
    let owner = w.owner.insecure_clone();
    grant_override(&mut w, &owner, u64::MAX - 50 * ONE, 3)
        .expect("override up to remaining is allowed");
    assert_err_contains(
        grant_override(&mut w, &owner, u64::MAX - 50 * ONE + 1, 3),
        "OverrideAboveCap",
    );
}

#[test]
fn claim_zero_copy_layouts_have_no_padding_and_a_zero_slot_is_a_known_shape() {
    fn assert_pod<T: bytemuck::Pod>() {}
    assert_pod::<Entry>();
    assert_pod::<Ledger>();
    assert_eq!(std::mem::size_of::<Entry>(), 8 + 8 + 32 + 8 + 8 + 1 + 1 + 6);
    assert_eq!(std::mem::align_of::<Entry>(), 8);
    assert_eq!(
        std::mem::size_of::<Ledger>(),
        32 + 4 + 2 + 1 + 1 + LEDGER_CAPACITY * 72
    );
    assert_eq!(std::mem::align_of::<Ledger>(), 8);
    // A never-written slot is all zero, which decodes as kind=OPENED reason=OK
    // at ts=0. Readers must bound by `total`; the indexer does (ring.ts:65).
    let zero: Entry = bytemuck::Zeroable::zeroed();
    assert_eq!(zero.kind, KIND_OPENED);
    assert_eq!(zero.reason, REASON_OK);
    assert_eq!(zero.ts, 0);
}

// ---------------------------------------------------------------------------
// Override and nonce.
// ---------------------------------------------------------------------------

#[test]
fn claim_an_override_cannot_exceed_remaining_cap_and_cannot_be_used_twice() {
    let mut w = setup();
    let owner = w.owner.insecure_clone();
    for n in 1..=4 {
        charge(&mut w, 100 * ONE, n).expect("paid");
    }
    assert_eq!(read_mandate(&w.svm, &w.mandate).remaining(), 100 * ONE);

    assert_err_contains(
        grant_override(&mut w, &owner, 100 * ONE + 1, 5),
        "OverrideAboveCap",
    );
    grant_override(&mut w, &owner, 100 * ONE, 5).expect("within remaining");

    // Cap shrinks under the override before it is used: still refused by cap.
    charge(&mut w, 1 * ONE, 6).expect("paid");
    charge(&mut w, 100 * ONE, 5).expect("refusal confirms");
    assert_eq!(last_entry(&w.svm, &w.ledger).reason, REASON_STALE_NONCE);
    assert_eq!(balance(&w.svm, &w.destination), 401 * ONE);

    // Fresh override for the remaining 99, consumed exactly once.
    grant_override(&mut w, &owner, 99 * ONE, 7).expect("granted");
    charge(&mut w, 99 * ONE, 7).expect("paid");
    let m = read_mandate(&w.svm, &w.mandate);
    assert_eq!(m.status, STATUS_EXHAUSTED);
    assert_eq!(m.override_nonce, 0);
    charge(&mut w, 99 * ONE, 7).expect("refusal confirms");
    assert_eq!(last_entry(&w.svm, &w.ledger).reason, REASON_NOT_ACTIVE);
    assert_eq!(balance(&w.svm, &w.destination), 500 * ONE);
}

#[test]
fn claim_the_same_nonce_twice_in_one_transaction_pays_once() {
    let mut w = setup();
    let a = charge_ix(&w, 50 * ONE, 1);
    let b = charge_ix(&w, 50 * ONE, 1);
    let agent = w.agent.insecure_clone();
    send(&mut w.svm, &agent, &[&agent], &[a, b]).expect("both confirm");
    assert_eq!(balance(&w.svm, &w.destination), 50 * ONE);
    assert_eq!(last_entry(&w.svm, &w.ledger).reason, REASON_STALE_NONCE);
}

// ---------------------------------------------------------------------------
// Lifecycle: revoked and expired stay that way.
// ---------------------------------------------------------------------------

#[test]
fn claim_a_revoked_mandate_cannot_be_charged_overridden_or_revived() {
    let mut w = setup();
    let owner = w.owner.insecure_clone();
    revoke(&mut w, &owner).expect("revoked");
    let src = token_account(&w.svm, &w.source);
    assert!(
        src.delegate.is_none(),
        "revoke must drop the SPL delegation"
    );

    charge(&mut w, 10 * ONE, 1).expect("refusal confirms");
    assert_eq!(last_entry(&w.svm, &w.ledger).reason, REASON_NOT_ACTIVE);
    assert_err_contains(
        grant_override(&mut w, &owner, 10 * ONE, 1),
        "MandateNotActive",
    );
    assert_err_contains(revoke(&mut w, &owner), "MandateNotActive");

    // Re-approving the delegation by hand does not revive the mandate.
    let ix = spl_token::instruction::approve(
        &spl_token::ID,
        &w.source,
        &w.mandate,
        &owner.pubkey(),
        &[],
        500 * ONE,
    )
    .unwrap();
    send(&mut w.svm, &owner, &[&owner], &[ix]).expect("owner re-approves outside the program");
    charge(&mut w, 10 * ONE, 1).expect("refusal confirms");
    assert_eq!(last_entry(&w.svm, &w.ledger).reason, REASON_NOT_ACTIVE);
    assert_eq!(balance(&w.svm, &w.destination), 0);
}

#[test]
fn claim_an_expired_mandate_is_refused_even_while_its_status_is_still_active() {
    let mut w = setup();
    set_clock(&mut w, FAR_FUTURE);
    assert_eq!(read_mandate(&w.svm, &w.mandate).status, STATUS_ACTIVE);
    charge(&mut w, 10 * ONE, 1).expect("refusal confirms");
    assert_eq!(last_entry(&w.svm, &w.ledger).reason, REASON_EXPIRED);
    assert_eq!(read_mandate(&w.svm, &w.mandate).status, STATUS_EXPIRED);
    assert_eq!(balance(&w.svm, &w.destination), 0);
}

// ---------------------------------------------------------------------------
// Findings. Each pins current behaviour; invert when fixed.
// ---------------------------------------------------------------------------

/// FINDING 1: once `charge` flips status to EXPIRED (or the cap flips it to
/// EXHAUSTED), `revoke_mandate` is rejected, so the program never drops the
/// SPL delegation on those paths and `close_mandate` does not either.
#[test]
fn finding_1_expired_status_locks_out_revoke_and_the_delegation_survives_close() {
    let mut w = setup();
    let owner = w.owner.insecure_clone();
    charge(&mut w, 100 * ONE, 1).expect("paid");
    set_clock(&mut w, FAR_FUTURE);
    charge(&mut w, 10 * ONE, 2).expect("refusal flips status");
    assert_eq!(read_mandate(&w.svm, &w.mandate).status, STATUS_EXPIRED);

    assert_err_contains(revoke(&mut w, &owner), "MandateNotActive");
    close(&mut w, &owner).expect("close succeeds");
    assert!(w
        .svm
        .get_account(&w.mandate)
        .map(|a| a.data.is_empty())
        .unwrap_or(true));

    let src = token_account(&w.svm, &w.source);
    assert_eq!(
        src.delegate,
        anchor_lang::solana_program::program_option::COption::Some(w.mandate)
    );
    assert_eq!(
        src.delegated_amount,
        400 * ONE,
        "400 remains delegated to a closed mandate's PDA"
    );
}

/// FINDING 2: `grant_override` accepts a nonce at or below `last_nonce`, and a
/// pending override is silently orphaned when a later nonce pays first. Both
/// leave an OVERRIDE entry on the ledger that no charge can ever consume.
#[test]
fn finding_2_grant_override_accepts_a_nonce_that_can_never_pay() {
    let mut w = setup();
    let owner = w.owner.insecure_clone();
    grant_override(&mut w, &owner, 180 * ONE, 7).expect("granted for nonce 7");
    charge(&mut w, 50 * ONE, 8).expect("nonce 8 pays first");
    charge(&mut w, 180 * ONE, 7).expect("refusal confirms");
    assert_eq!(last_entry(&w.svm, &w.ledger).reason, REASON_STALE_NONCE);
    assert_eq!(
        read_mandate(&w.svm, &w.mandate).override_nonce,
        7,
        "orphaned override still pending"
    );

    // And the owner can mint a dead override directly.
    grant_override(&mut w, &owner, 180 * ONE, 3).expect("accepted although 3 <= last_nonce 8");
    assert_eq!(last_entry(&w.svm, &w.ledger).kind, KIND_OVERRIDE);
    charge(&mut w, 180 * ONE, 3).expect("refusal confirms");
    assert_eq!(last_entry(&w.svm, &w.ledger).reason, REASON_STALE_NONCE);
}

/// FINDING 3: the agent chooses nonces, and `last_nonce` only ever rises, so a
/// single paid charge at u64::MAX makes every future charge stale. The owner
/// has no instruction that resets it; the only exit is revoke and re-open.
#[test]
fn finding_3_a_paid_charge_at_nonce_u64_max_strands_the_mandate() {
    let mut w = setup();
    charge(&mut w, 1 * ONE, u64::MAX).expect("paid");
    charge(&mut w, 1 * ONE, 1).expect("refusal confirms");
    assert_eq!(last_entry(&w.svm, &w.ledger).reason, REASON_STALE_NONCE);
    let m = read_mandate(&w.svm, &w.mandate);
    assert_eq!(m.last_nonce, u64::MAX);
    assert_eq!(m.status, STATUS_ACTIVE);
    assert_eq!(
        m.remaining(),
        499 * ONE,
        "499 of cap can never be spent under this mandate"
    );
}

/// FINDING 4: a decline raised by the token program (frozen account here) is a
/// transaction error, so it is exactly the unrecorded refusal the product says
/// it does not produce. `evaluate` does not look at `state`.
#[test]
fn finding_4_a_frozen_account_declines_without_any_record() {
    let mut w = setup_with(Limits {
        freeze_authority: true,
        ..Limits::default()
    });
    let owner = w.owner.insecure_clone();
    let ix = spl_token::instruction::freeze_account(
        &spl_token::ID,
        &w.destination,
        &w.mint,
        &owner.pubkey(),
        &[],
    )
    .unwrap();
    send(&mut w.svm, &owner, &[&owner], &[ix])
        .expect("merchant account frozen by the mint authority");

    let before = read_ledger(&w.svm, &w.ledger).total;
    assert_err_contains(charge(&mut w, 10 * ONE, 1), "frozen");
    assert_eq!(
        read_ledger(&w.svm, &w.ledger).total,
        before,
        "no ledger entry for the decline"
    );
    assert_eq!(read_mandate(&w.svm, &w.mandate).refusal_count, 0);
}

/// FINDING 5: the purpose limit is checked in characters and allocated in
/// bytes, so a 64-character multibyte purpose passes the check and then fails
/// to persist with a generic serialisation error instead of PurposeTooLong.
#[test]
fn finding_5_purpose_limit_counts_chars_but_the_account_is_sized_in_bytes() {
    let mut w = setup();
    let owner = w.owner.insecure_clone();
    let purpose = "é".repeat(PURPOSE_MAX_LEN);
    assert_eq!(purpose.chars().count(), PURPOSE_MAX_LEN);
    assert_eq!(purpose.len(), 2 * PURPOSE_MAX_LEN);
    let ix = open_ix(
        &owner.pubkey(),
        2,
        &w.agent.pubkey(),
        &w.merchant_owner,
        &w.source,
        &w.mint,
        &Limits::default(),
        &purpose,
    );
    let err = send(&mut w.svm, &owner, &[&owner], &[ix]).expect_err("must not persist");
    assert!(
        !err.contains("PurposeTooLong"),
        "got the specific error after all:\n{err}"
    );
    assert!(
        err.contains("AccountDidNotSerialize"),
        "unexpected error:\n{err}"
    );
}

/// FINDING 6: one SPL delegate per token account. Opening a second mandate on
/// the same source re-points the delegation and the first mandate is dead
/// without a REVOKED entry; it only finds out at its next charge.
#[test]
fn finding_6_a_second_mandate_on_the_same_source_disables_the_first_silently() {
    let mut w = setup();
    let owner = w.owner.insecure_clone();
    let ix = open_ix(
        &owner.pubkey(),
        2,
        &w.agent.pubkey(),
        &w.merchant_owner,
        &w.source,
        &w.mint,
        &Limits::default(),
        "second",
    );
    send(&mut w.svm, &owner, &[&owner], &[ix]).expect("second mandate on the same source");

    let m1 = read_mandate(&w.svm, &w.mandate);
    assert_eq!(m1.status, STATUS_ACTIVE, "mandate 1 still says active");
    charge(&mut w, 10 * ONE, 1).expect("refusal confirms");
    assert_eq!(
        last_entry(&w.svm, &w.ledger).reason,
        REASON_DELEGATE_MISSING
    );
}

/// FINDING 7: the ring keeps 32 entries and the agent can write a refusal at
/// will, so 32 refusals evict every PAID row from the on-chain window. `total`
/// still counts, and the transactions remain, but the account no longer shows
/// the payment.
#[test]
fn finding_7_refusal_spam_evicts_paid_entries_from_the_ring() {
    let mut w = setup();
    charge(&mut w, 50 * ONE, 1).expect("paid");
    for _ in 0..LEDGER_CAPACITY {
        charge(&mut w, 180 * ONE, 2).expect("refusal confirms");
    }
    let ledger = read_ledger(&w.svm, &w.ledger);
    assert_eq!(ledger.total as usize, 2 + LEDGER_CAPACITY);
    assert!(
        ledger.entries.iter().all(|e| e.kind == KIND_REFUSED),
        "a PAID or OPENED row survived"
    );
    assert_eq!(read_mandate(&w.svm, &w.mandate).spent, 50 * ONE);
}
