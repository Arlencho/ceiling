//! Go/no-go for a constant-product swap on the devnet SPL token-swap program.
//! The bytes are the program account itself, loaded with LiteSVM the same way
//! the other program suites load veto.so.
//!
//! Source account: SwaPpA9LAaLfeLi3a68M4DjnLqgtticKg6CnyNwgAC8
//! sha256: f86b866c8717f4a052bd61b36bfd1dee203d32673a0bb5cb1fbd8b99f8e65719
//!
//! Dumped with:
//! `solana program dump -u devnet SwaPpA9LAaLfeLi3a68M4DjnLqgtticKg6CnyNwgAC8 programs/veto/tests/fixtures/spl_token_swap.so`
//!
//! This build is the token-swap v2 program (that declare_id). Initialize data
//! is tag 0, the bump byte, eight little-endian fee u64s, the curve type, and
//! 32 curve-parameter bytes. A zero fee is numerator 0 and denominator 0.
//! Swap data is tag 1, amount_in, minimum_amount_out. The program reads 10
//! accounts and then an optional host fee account. A 14-account swap is the
//! later program's layout, and this one rejects it.

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{
            instruction::{AccountMeta, Instruction},
            program_option::COption,
            program_pack::Pack,
            system_instruction,
        },
    },
    anchor_spl::token::spl_token,
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    std::str::FromStr,
};

const DECIMALS: u8 = 6;
const ONE: u64 = 1_000_000;
/// SwapVersion::LATEST_LEN: one version byte plus SwapV1::LEN (323).
const SWAP_ACCOUNT_LEN: u64 = 324;
const LIQUIDITY: u64 = 1_000_000 * ONE;
const AMOUNT_IN: u64 = 10 * ONE;

const TOKEN_SWAP_ID: &str = "SwaPpA9LAaLfeLi3a68M4DjnLqgtticKg6CnyNwgAC8";
/// SWAP_PROGRAM_OWNER_FEE_ADDRESS compiled into this ELF. The fee account's
/// owner must be this address or initialize returns InvalidOwner.
const FEE_OWNER: &str = "HfoTxFR1Tm6kGmWgYWD6J7YHVy1UwqSULUGVLXkJqaKN";
const PROGRAM_BYTES: &[u8] = include_bytes!("fixtures/spl_token_swap.so");

/// Eight fee words, in instruction order.
struct PoolFees {
    trade_numerator: u64,
    trade_denominator: u64,
    owner_trade_numerator: u64,
    owner_trade_denominator: u64,
    owner_withdraw_numerator: u64,
    owner_withdraw_denominator: u64,
    host_numerator: u64,
    host_denominator: u64,
}

/// The schedule named for the gate: trade 25/10000, owner 0, host 0.
const REQUESTED_FEES: PoolFees = PoolFees {
    trade_numerator: 25,
    trade_denominator: 10_000,
    owner_trade_numerator: 0,
    owner_trade_denominator: 0,
    owner_withdraw_numerator: 0,
    owner_withdraw_denominator: 0,
    host_numerator: 0,
    host_denominator: 0,
};

/// The only schedule this ELF accepts. Anything else, including REQUESTED_FEES,
/// logs "The provided fee does not match the program owner's constraints".
const ENFORCED_FEES: PoolFees = PoolFees {
    trade_numerator: 25,
    trade_denominator: 10_000,
    owner_trade_numerator: 5,
    owner_trade_denominator: 10_000,
    owner_withdraw_numerator: 0,
    owner_withdraw_denominator: 0,
    host_numerator: 20,
    host_denominator: 100,
};

struct Market {
    svm: LiteSVM,
    payer: Keypair,
    owner: Keypair,
    delegate: Keypair,
    program_id: Pubkey,
    swap: Pubkey,
    authority: Pubkey,
    mint_a: Pubkey,
    mint_b: Pubkey,
    vault_a: Pubkey,
    vault_b: Pubkey,
    pool_mint: Pubkey,
    fee_account: Pubkey,
    user_source: Pubkey,
    user_dest: Pubkey,
}

fn token_swap_id() -> Pubkey {
    Pubkey::from_str(TOKEN_SWAP_ID).unwrap()
}

fn fee_owner() -> Pubkey {
    Pubkey::from_str(FEE_OWNER).unwrap()
}

fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    signers: &[&Keypair],
    ixs: &[Instruction],
) -> Result<Vec<String>, String> {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers)
        .map_err(|e| format!("{e:?}"))?;
    match svm.send_transaction(tx) {
        Ok(meta) => {
            svm.expire_blockhash();
            Ok(meta.logs)
        }
        Err(e) => {
            svm.expire_blockhash();
            Err(format!("{:?}\n{}", e.err, e.meta.pretty_logs()))
        }
    }
}

fn token_account(svm: &LiteSVM, key: &Pubkey) -> spl_token::state::Account {
    let raw = svm.get_account(key).expect("token account exists");
    spl_token::state::Account::unpack(&raw.data).expect("token account unpacks")
}

fn boot() -> (LiteSVM, Keypair) {
    let mut svm = LiteSVM::new();
    let e_flags = u32::from_le_bytes(PROGRAM_BYTES[48..52].try_into().unwrap());
    assert_eq!(
        e_flags, 0,
        "spl_token_swap.so must be SBPF v0 for LiteSVM 0.10"
    );
    let program_id = token_swap_id();
    svm.add_program(program_id, PROGRAM_BYTES)
        .expect("token-swap program loads");
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
    (svm, payer)
}

fn create_mint(svm: &mut LiteSVM, payer: &Keypair) -> Pubkey {
    let mint_kp = Keypair::new();
    let mint = mint_kp.pubkey();
    let ixs = [
        system_instruction::create_account(
            &payer.pubkey(),
            &mint,
            10_000_000,
            spl_token::state::Mint::LEN as u64,
            &spl_token::ID,
        ),
        spl_token::instruction::initialize_mint2(
            &spl_token::ID,
            &mint,
            &payer.pubkey(),
            None,
            DECIMALS,
        )
        .unwrap(),
    ];
    send(svm, payer, &[payer, &mint_kp], &ixs).expect("create mint");
    mint
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

fn mint_to(svm: &mut LiteSVM, payer: &Keypair, mint: &Pubkey, dest: &Pubkey, amount: u64) {
    send(
        svm,
        payer,
        &[payer],
        &[spl_token::instruction::mint_to(
            &spl_token::ID,
            mint,
            dest,
            &payer.pubkey(),
            &[],
            amount,
        )
        .unwrap()],
    )
    .expect("mint");
}

fn push_u64(buf: &mut Vec<u8>, value: u64) {
    buf.extend_from_slice(&value.to_le_bytes());
}

fn initialize_data(nonce: u8, fees: &PoolFees) -> Vec<u8> {
    let mut buf = Vec::with_capacity(99);
    buf.push(0);
    buf.push(nonce);
    for word in [
        fees.trade_numerator,
        fees.trade_denominator,
        fees.owner_trade_numerator,
        fees.owner_trade_denominator,
        fees.owner_withdraw_numerator,
        fees.owner_withdraw_denominator,
        fees.host_numerator,
        fees.host_denominator,
    ] {
        push_u64(&mut buf, word);
    }
    buf.push(0);
    buf.extend_from_slice(&[0u8; 32]);
    assert_eq!(buf.len(), 99);
    buf
}

fn swap_data(amount_in: u64, minimum_amount_out: u64) -> Vec<u8> {
    let mut buf = Vec::with_capacity(17);
    buf.push(1);
    push_u64(&mut buf, amount_in);
    push_u64(&mut buf, minimum_amount_out);
    buf
}

fn initialize_ix(
    program_id: Pubkey,
    swap: Pubkey,
    authority: Pubkey,
    vault_a: Pubkey,
    vault_b: Pubkey,
    pool_mint: Pubkey,
    fee_account: Pubkey,
    lp_dest: Pubkey,
    nonce: u8,
    fees: &PoolFees,
) -> Instruction {
    Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new(swap, true),
            AccountMeta::new_readonly(authority, false),
            AccountMeta::new_readonly(vault_a, false),
            AccountMeta::new_readonly(vault_b, false),
            AccountMeta::new(pool_mint, false),
            AccountMeta::new_readonly(fee_account, false),
            AccountMeta::new(lp_dest, false),
            AccountMeta::new_readonly(spl_token::ID, false),
        ],
        data: initialize_data(nonce, fees),
    }
}

/// Ten accounts. This program treats the tenth as the single token program.
/// No host fee account is appended.
fn swap_ix_ten(
    program_id: Pubkey,
    swap: Pubkey,
    authority: Pubkey,
    delegate: Pubkey,
    user_source: Pubkey,
    vault_a: Pubkey,
    vault_b: Pubkey,
    user_dest: Pubkey,
    pool_mint: Pubkey,
    fee_account: Pubkey,
) -> Instruction {
    Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new_readonly(swap, false),
            AccountMeta::new_readonly(authority, false),
            AccountMeta::new_readonly(delegate, true),
            AccountMeta::new(user_source, false),
            AccountMeta::new(vault_a, false),
            AccountMeta::new(vault_b, false),
            AccountMeta::new(user_dest, false),
            AccountMeta::new(pool_mint, false),
            AccountMeta::new(fee_account, false),
            AccountMeta::new_readonly(spl_token::ID, false),
        ],
        data: swap_data(AMOUNT_IN, 1),
    }
}

/// Fourteen accounts, the later program's swap list, with no host fee account.
fn swap_ix_fourteen(
    program_id: Pubkey,
    swap: Pubkey,
    authority: Pubkey,
    delegate: Pubkey,
    user_source: Pubkey,
    vault_a: Pubkey,
    vault_b: Pubkey,
    user_dest: Pubkey,
    pool_mint: Pubkey,
    fee_account: Pubkey,
    mint_a: Pubkey,
    mint_b: Pubkey,
) -> Instruction {
    Instruction {
        program_id,
        accounts: vec![
            AccountMeta::new_readonly(swap, false),
            AccountMeta::new_readonly(authority, false),
            AccountMeta::new_readonly(delegate, true),
            AccountMeta::new(user_source, false),
            AccountMeta::new(vault_a, false),
            AccountMeta::new(vault_b, false),
            AccountMeta::new(user_dest, false),
            AccountMeta::new(pool_mint, false),
            AccountMeta::new(fee_account, false),
            AccountMeta::new_readonly(mint_a, false),
            AccountMeta::new_readonly(mint_b, false),
            AccountMeta::new_readonly(spl_token::ID, false),
            AccountMeta::new_readonly(spl_token::ID, false),
            AccountMeta::new_readonly(spl_token::ID, false),
        ],
        data: swap_data(AMOUNT_IN, 1),
    }
}

fn open_market(fees: &PoolFees) -> Result<Market, String> {
    let (mut svm, payer) = boot();
    let owner = Keypair::new();
    let delegate = Keypair::new();
    svm.airdrop(&owner.pubkey(), 100_000_000_000).unwrap();
    svm.airdrop(&delegate.pubkey(), 100_000_000_000).unwrap();
    let program_id = token_swap_id();

    let mint_a = create_mint(&mut svm, &payer);
    let mint_b = create_mint(&mut svm, &payer);
    let swap_kp = Keypair::new();
    let swap = swap_kp.pubkey();
    let (authority, bump) = Pubkey::find_program_address(&[swap.as_ref()], &program_id);
    let vault_a = create_token_account(&mut svm, &payer, &mint_a, &authority);
    let vault_b = create_token_account(&mut svm, &payer, &mint_b, &authority);
    mint_to(&mut svm, &payer, &mint_a, &vault_a, LIQUIDITY);
    mint_to(&mut svm, &payer, &mint_b, &vault_b, LIQUIDITY);

    let pool_mint_kp = Keypair::new();
    let pool_mint = pool_mint_kp.pubkey();
    send(
        &mut svm,
        &payer,
        &[&payer, &pool_mint_kp],
        &[
            system_instruction::create_account(
                &payer.pubkey(),
                &pool_mint,
                10_000_000,
                spl_token::state::Mint::LEN as u64,
                &spl_token::ID,
            ),
            spl_token::instruction::initialize_mint2(
                &spl_token::ID,
                &pool_mint,
                &authority,
                None,
                DECIMALS,
            )
            .unwrap(),
        ],
    )
    .expect("create pool mint");

    let fee_account = create_token_account(&mut svm, &payer, &pool_mint, &fee_owner());
    let lp_dest = create_token_account(&mut svm, &payer, &pool_mint, &payer.pubkey());
    let init = initialize_ix(
        program_id,
        swap,
        authority,
        vault_a,
        vault_b,
        pool_mint,
        fee_account,
        lp_dest,
        bump,
        fees,
    );
    send(
        &mut svm,
        &payer,
        &[&payer, &swap_kp],
        &[
            system_instruction::create_account(
                &payer.pubkey(),
                &swap,
                10_000_000,
                SWAP_ACCOUNT_LEN,
                &program_id,
            ),
            init,
        ],
    )?;

    let user_source = create_token_account(&mut svm, &payer, &mint_a, &owner.pubkey());
    let user_dest = create_token_account(&mut svm, &payer, &mint_b, &owner.pubkey());
    mint_to(&mut svm, &payer, &mint_a, &user_source, AMOUNT_IN);
    send(
        &mut svm,
        &payer,
        &[&payer, &owner],
        &[spl_token::instruction::approve(
            &spl_token::ID,
            &user_source,
            &delegate.pubkey(),
            &owner.pubkey(),
            &[],
            AMOUNT_IN,
        )
        .unwrap()],
    )
    .expect("owner approves the delegate");

    Ok(Market {
        svm,
        payer,
        owner,
        delegate,
        program_id,
        swap,
        authority,
        mint_a,
        mint_b,
        vault_a,
        vault_b,
        pool_mint,
        fee_account,
        user_source,
        user_dest,
    })
}

#[test]
fn zero_owner_and_host_fees_are_rejected() {
    let err = match open_market(&REQUESTED_FEES) {
        Err(err) => err,
        Ok(_) => panic!("requested fees must be rejected"),
    };
    assert!(
        err.contains("The provided fee does not match the program owner's constraints"),
        "expected the production fee constraint, got:\n{err}"
    );
}

#[test]
fn fourteen_account_swap_does_not_move_balances() {
    let mut market = open_market(&ENFORCED_FEES).expect("enforced fees initialize");
    let before = token_account(&market.svm, &market.user_source).amount;
    let ix = swap_ix_fourteen(
        market.program_id,
        market.swap,
        market.authority,
        market.delegate.pubkey(),
        market.user_source,
        market.vault_a,
        market.vault_b,
        market.user_dest,
        market.pool_mint,
        market.fee_account,
        market.mint_a,
        market.mint_b,
    );
    assert_eq!(ix.accounts.len(), 14);
    let err = send(
        &mut market.svm,
        &market.payer,
        &[&market.payer, &market.delegate],
        &[ix],
    )
    .expect_err("14-account swap must be rejected");
    assert!(
        err.contains(
            "The provided token program does not match the token program expected by the swap"
        ),
        "expected the token-program mismatch, got:\n{err}"
    );
    assert_eq!(
        token_account(&market.svm, &market.user_source).amount,
        before
    );
    assert_eq!(token_account(&market.svm, &market.user_dest).amount, 0);
}

#[test]
fn delegated_signer_moves_balances_through_constant_product_swap() {
    let mut market = open_market(&ENFORCED_FEES).expect("enforced fees initialize");
    let approved = token_account(&market.svm, &market.user_source);
    assert_eq!(approved.owner, market.owner.pubkey());
    assert_ne!(approved.owner, market.delegate.pubkey());
    assert_eq!(approved.delegate, COption::Some(market.delegate.pubkey()));
    assert_eq!(approved.delegated_amount, AMOUNT_IN);

    let ix = swap_ix_ten(
        market.program_id,
        market.swap,
        market.authority,
        market.delegate.pubkey(),
        market.user_source,
        market.vault_a,
        market.vault_b,
        market.user_dest,
        market.pool_mint,
        market.fee_account,
    );
    assert_eq!(ix.accounts.len(), 10);
    // The source owner does not sign. The delegate is the transfer authority.
    send(
        &mut market.svm,
        &market.payer,
        &[&market.payer, &market.delegate],
        &[ix],
    )
    .expect("delegate swap");

    let source_after = token_account(&market.svm, &market.user_source);
    let dest_after = token_account(&market.svm, &market.user_dest);
    assert_eq!(source_after.owner, market.owner.pubkey());
    assert_eq!(source_after.amount, 0);
    assert!(dest_after.amount > 0, "destination received tokens");
    assert!(
        dest_after.amount < AMOUNT_IN,
        "constant product plus the trade fee returns less than the input"
    );
    assert_eq!(
        token_account(&market.svm, &market.vault_a).amount,
        LIQUIDITY + AMOUNT_IN
    );
    assert_eq!(
        token_account(&market.svm, &market.vault_b).amount,
        LIQUIDITY - dest_after.amount
    );
}
