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

use base64::Engine;
use std::str::FromStr;

const SKR: &str = "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3";
const ONE: u64 = 1_000_000;
const FAR_FUTURE: i64 = 4_000_000_000;
const PROGRAM_BYTES: &[u8] =
    include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/veto.so"));

struct World {
    svm: LiteSVM,
    owner: Keypair,
    agent: Keypair,
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

fn setup() -> World {
    let mut svm = LiteSVM::new();
    load_program(&mut svm);

    let owner = Keypair::new();
    let agent = Keypair::new();
    let merchant_owner = Pubkey::new_unique();
    svm.airdrop(&owner.pubkey(), 100_000_000_000).unwrap();
    svm.airdrop(&agent.pubkey(), 100_000_000_000).unwrap();

    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/skr-mint.mainnet.json")).unwrap();
    assert_eq!(fixture["address"].as_str().unwrap(), SKR);
    let mint = Pubkey::from_str(SKR).unwrap();
    let mint_owner = Pubkey::from_str(fixture["owner"].as_str().unwrap()).unwrap();
    assert_eq!(mint_owner, spl_token::ID);
    let data = base64::engine::general_purpose::STANDARD
        .decode(fixture["data_base64"].as_str().unwrap())
        .unwrap();
    let state = spl_token::state::Mint::unpack(&data).expect("classic mint bytes");
    assert_eq!(state.decimals, 6);
    assert!(state.is_initialized);
    svm.set_account(
        mint,
        solana_account::Account {
            lamports: fixture["lamports"].as_u64().unwrap(),
            data,
            owner: mint_owner,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    let source = create_token_account(&mut svm, &owner, &mint, &owner.pubkey());
    let destination = create_token_account(&mut svm, &owner, &mint, &merchant_owner);

    // Fund only the simulated account, preserving the real mint and its authorities.
    let mut raw = svm.get_account(&source).unwrap();
    let mut token = spl_token::state::Account::unpack(&raw.data).unwrap();
    token.amount = 1_000 * ONE;
    spl_token::state::Account::pack(token, &mut raw.data).unwrap();
    svm.set_account(source, raw).unwrap();
    assert_eq!(token_balance(&svm, &source), 1_000 * ONE);

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
                cap: 200 * ONE,
                per_tx_max: 10 * ONE,
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
fn real_skr_snapshot_pays_eight_refuses_twenty_five_and_denies_agent_widening() {
    let mut w = setup();
    let agent = w.agent.insecure_clone();
    let paid = charge_ix(&w, 8 * ONE, 1);
    send(&mut w.svm, &agent, &[&agent], &[paid]).unwrap();
    assert_eq!(token_balance(&w.svm, &w.source), 992 * ONE);
    assert_eq!(token_balance(&w.svm, &w.destination), 8 * ONE);
    let entry = last_entry(&w.svm, &w.ledger);
    assert_eq!(entry.kind, KIND_PAID);
    assert_eq!(entry.reason, REASON_OK);
    assert_eq!(entry.amount, 8 * ONE);

    let refused = charge_ix(&w, 25 * ONE, 2);
    send(&mut w.svm, &agent, &[&agent], &[refused]).expect("refusal confirms");
    assert_eq!(token_balance(&w.svm, &w.source), 992 * ONE);
    assert_eq!(token_balance(&w.svm, &w.destination), 8 * ONE);
    let entry = last_entry(&w.svm, &w.ledger);
    assert_eq!(entry.kind, KIND_REFUSED);
    assert_eq!(entry.reason, 5);
    assert_eq!(entry.reason, REASON_OVER_PER_TX_MAX);
    assert_eq!(entry.amount, 25 * ONE);
    assert_eq!(entry.suggested_override, 25 * ONE);
    let rule = read_mandate(&w.svm, &w.mandate);
    assert_eq!(rule.spent, 8 * ONE);
    assert_eq!(rule.spend_count, 1);
    assert_eq!(rule.refusal_count, 1);

    let before = w.svm.get_account(&w.mandate).unwrap().data;
    let widen = Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::GrantOverride {
            amount: 25 * ONE,
            nonce: 2,
        }
        .data(),
        veto::accounts::OwnerAction {
            owner: agent.pubkey(),
            mandate: w.mandate,
            ledger: w.ledger,
            source: w.source,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
    );
    let error = send(&mut w.svm, &agent, &[&agent], &[widen]).unwrap_err();
    assert!(error.contains("NotTheOwner"), "{error}");
    assert_eq!(w.svm.get_account(&w.mandate).unwrap().data, before);
    let rule = read_mandate(&w.svm, &w.mandate);
    assert_eq!(rule.cap, 200 * ONE);
    assert_eq!(rule.per_tx_max, 10 * ONE);
}

#[test]
fn a_hold_vault_opens_against_the_real_skr_snapshot() {
    let mut w = setup();
    let owner = w.owner.insecure_clone();
    let vault_id = 1_u64;
    let (vault, _) = Pubkey::find_program_address(
        &[b"hold", owner.pubkey().as_ref(), &vault_id.to_le_bytes()],
        &veto::id(),
    );
    let (vault_token, _) =
        Pubkey::find_program_address(&[b"hold-token", vault.as_ref()], &veto::id());
    let (ledger, _) = Pubkey::find_program_address(&[b"hold-ledger", vault.as_ref()], &veto::id());
    let init = Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::InitVault {
            args: veto::hold::InitVaultArgs {
                vault_id,
                guardian: Pubkey::default(),
                safe_address: Pubkey::new_unique(),
                daily_limit: 100 * ONE,
                delay_secs: veto::hold_state::HOLD_DELAY_1_DAY,
                big_share_bps: veto::hold_state::HOLD_DEFAULT_BIG_SHARE_BPS,
            },
        }
        .data(),
        veto::accounts::InitVault {
            owner: owner.pubkey(),
            vault,
            ledger,
            vault_token,
            mint: w.mint,
            token_program: spl_token::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(&mut w.svm, &owner, &[&owner], &[init]).expect("open SKR Hold vault");
    let raw = w.svm.get_account(&vault).unwrap();
    assert_eq!(raw.owner, veto::id());
    let state = veto::hold_state::HoldVault::try_deserialize(&mut raw.data.as_slice()).unwrap();
    assert_eq!(state.mint, w.mint);
    assert_eq!(state.owner, owner.pubkey());
    let raw = w.svm.get_account(&vault_token).unwrap();
    assert_eq!(raw.owner, spl_token::ID);
    let token = spl_token::state::Account::unpack(&raw.data).unwrap();
    assert_eq!(token.mint, w.mint);
    assert_eq!(token.owner, vault);
    assert_eq!(token.amount, 0);
}
