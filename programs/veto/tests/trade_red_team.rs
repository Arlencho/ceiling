//! Hostile trades against a rule the owner already opened.
//!
//! The signer on an attack is the agent key, except where the case is the
//! owner revoking, granting an override, or opening a bad rule. The token-swap
//! program is the ELF from `token_swap_fixture.rs`, loaded with `add_program`.
//! Every pool uses that file's enforced schedule: trade 25/10000, owner trade
//! 5/10000, owner withdraw 0/0, host 20/100. The fee account is owned by
//! HfoTxFR1Tm6kGmWgYWD6J7YHVy1UwqSULUGVLXkJqaKN.
//!
//! Build first with `ANCHOR_BUILD_SBF_ARCH=v0 anchor build --ignore-keys`.

use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{
            instruction::{AccountMeta, Instruction},
            program_option::COption,
            program_pack::Pack,
            system_instruction, system_program,
        },
        AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas,
    },
    anchor_spl::token::spl_token,
    litesvm::LiteSVM,
    solana_account::Account,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    std::str::FromStr,
    veto::{
        trade::OpenTradeRuleArgs, TradeEntry, TradeLedger, TradeRule, EXCHANGE_KIND_SPL_TOKEN_SWAP,
        REASON_DELEGATE_MISSING, REASON_DESTINATION_NOT_ALLOWED, REASON_EXPIRED, REASON_NOT_ACTIVE,
        REASON_OK, REASON_OVER_CAP, REASON_OVER_DAILY, REASON_OVER_PER_TX_MAX,
        REASON_POOL_NOT_ALLOWED, REASON_STALE_NONCE, STATUS_ACTIVE, STATUS_EXPIRED, STATUS_REVOKED,
        TRADE_KIND_OPENED, TRADE_KIND_REFUSED, TRADE_KIND_TRADED, TRADE_LEDGER_CAPACITY,
        TRADE_WINDOW_SECS,
    },
};

const IN_DECIMALS: u8 = 6;
const OUT_DECIMALS: u8 = 9;
const IN_ONE: u64 = 1_000_000;
const OUT_ONE: u64 = 1_000_000_000;
const FAR_FUTURE: i64 = 4_000_000_000;
const LIQUIDITY_IN: u64 = 1_000_000 * IN_ONE;
const LIQUIDITY_OUT: u64 = 1_000_000 * OUT_ONE;
const USER_FUNDS: u64 = 10_000 * IN_ONE;
const SWAP_ACCOUNT_LEN: u64 = 324;
const TOKEN_SWAP_ID: &str = "SwaPpA9LAaLfeLi3a68M4DjnLqgtticKg6CnyNwgAC8";
const FEE_OWNER: &str = "HfoTxFR1Tm6kGmWgYWD6J7YHVy1UwqSULUGVLXkJqaKN";
const TOKEN_2022_ID: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const VETO_BYTES: &[u8] =
    include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/veto.so"));
const SWAP_BYTES: &[u8] = include_bytes!("fixtures/spl_token_swap.so");

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

/// The only schedule this ELF accepts. See `token_swap_fixture.rs`.
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

#[derive(Clone, Copy)]
struct Rules {
    rule_id: u64,
    cap: u64,
    per_trade_max: u64,
    daily_limit: u64,
    floor_num: u64,
    floor_den: u64,
    expires_at: i64,
    purpose: &'static str,
}

impl Default for Rules {
    fn default() -> Self {
        Self {
            rule_id: 1,
            cap: 100 * IN_ONE,
            per_trade_max: 20 * IN_ONE,
            daily_limit: 50 * IN_ONE,
            floor_num: 1,
            floor_den: 1,
            expires_at: FAR_FUTURE,
            purpose: "swap the input token",
        }
    }
}

#[derive(Clone, Copy)]
struct Pool {
    pool: Pubkey,
    authority: Pubkey,
    vault_in: Pubkey,
    vault_out: Pubkey,
    pool_mint: Pubkey,
    fee_account: Pubkey,
}

struct World {
    svm: LiteSVM,
    owner: Keypair,
    agent: Keypair,
    in_mint: Pubkey,
    out_mint: Pubkey,
    source: Pubkey,
    destination: Pubkey,
    agent_in: Pubkey,
    agent_out: Pubkey,
    exchange_program: Pubkey,
    pool: Pool,
    rule: Pubkey,
    ledger: Pubkey,
}

struct Snap {
    source: u64,
    destination: u64,
    vault_in: u64,
    vault_out: u64,
    agent_in: u64,
    agent_out: u64,
    delegated: u64,
    agent_lamports: u64,
    fee: u64,
}

struct TradeIx {
    agent: Pubkey,
    rule: Pubkey,
    ledger: Pubkey,
    source: Pubkey,
    destination: Pubkey,
    exchange_program: Pubkey,
    pool: Pubkey,
    pool_authority: Pubkey,
    pool_in_vault: Pubkey,
    pool_out_vault: Pubkey,
    pool_mint: Pubkey,
    pool_fee_account: Pubkey,
    token_program: Pubkey,
}

fn token_swap_id() -> Pubkey {
    Pubkey::from_str(TOKEN_SWAP_ID).unwrap()
}

fn fee_owner() -> Pubkey {
    Pubkey::from_str(FEE_OWNER).unwrap()
}

fn token_2022_id() -> Pubkey {
    Pubkey::from_str(TOKEN_2022_ID).unwrap()
}

fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    signers: &[&Keypair],
    ixs: &[Instruction],
) -> Result<litesvm::types::TransactionMetadata, String> {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers)
        .map_err(|e| format!("{e:?}"))?;
    match svm.send_transaction(tx) {
        Ok(meta) => {
            svm.expire_blockhash();
            Ok(meta)
        }
        Err(e) => {
            svm.expire_blockhash();
            Err(format!("{:?}\n{}", e.err, e.meta.pretty_logs()))
        }
    }
}

fn assert_err(result: Result<litesvm::types::TransactionMetadata, String>, needle: &str) {
    match result {
        Ok(meta) => panic!(
            "expected an error containing {needle:?}, transaction succeeded\n{}",
            meta.logs.join("\n")
        ),
        Err(e) => assert!(
            e.contains(needle),
            "expected {needle:?} in error, got:\n{e}"
        ),
    }
}

fn now(svm: &LiteSVM) -> i64 {
    let clock: Clock = svm.get_sysvar();
    clock.unix_timestamp
}

fn warp(svm: &mut LiteSVM, unix_timestamp: i64) {
    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = unix_timestamp;
    svm.set_sysvar(&clock);
}

fn token_account(svm: &LiteSVM, key: &Pubkey) -> spl_token::state::Account {
    let raw = svm.get_account(key).expect("token account exists");
    spl_token::state::Account::unpack(&raw.data).expect("token account unpacks")
}

fn token_amount(svm: &LiteSVM, key: &Pubkey) -> u64 {
    token_account(svm, key).amount
}

fn lamports(svm: &LiteSVM, key: &Pubkey) -> u64 {
    svm.get_account(key)
        .map(|account| account.lamports)
        .unwrap_or(0)
}

fn read_rule(svm: &LiteSVM, key: &Pubkey) -> TradeRule {
    let raw = svm.get_account(key).expect("rule exists");
    let mut data: &[u8] = &raw.data;
    TradeRule::try_deserialize(&mut data).expect("rule deserializes")
}

fn read_ledger(svm: &LiteSVM, key: &Pubkey) -> TradeLedger {
    let raw = svm.get_account(key).expect("trade ledger exists");
    let start = 8;
    let end = start + std::mem::size_of::<TradeLedger>();
    *bytemuck::from_bytes::<TradeLedger>(&raw.data[start..end])
}

fn last_entry(svm: &LiteSVM, key: &Pubkey) -> TradeEntry {
    let ledger = read_ledger(svm, key);
    let last = (ledger.head as usize + TRADE_LEDGER_CAPACITY - 1) % TRADE_LEDGER_CAPACITY;
    ledger.entries[last]
}

fn snap(w: &World) -> Snap {
    let source = token_account(&w.svm, &w.source);
    Snap {
        source: source.amount,
        destination: token_amount(&w.svm, &w.destination),
        vault_in: token_amount(&w.svm, &w.pool.vault_in),
        vault_out: token_amount(&w.svm, &w.pool.vault_out),
        agent_in: token_amount(&w.svm, &w.agent_in),
        agent_out: token_amount(&w.svm, &w.agent_out),
        delegated: source.delegated_amount,
        agent_lamports: lamports(&w.svm, &w.agent.pubkey()),
        fee: token_amount(&w.svm, &w.pool.fee_account),
    }
}

fn assert_unmoved(before: &Snap, after: &Snap) {
    assert_eq!(after.source, before.source, "source balance changed");
    assert_eq!(
        after.destination, before.destination,
        "destination balance changed"
    );
    assert_eq!(after.vault_in, before.vault_in, "input vault changed");
    assert_eq!(after.vault_out, before.vault_out, "output vault changed");
    assert_eq!(
        after.agent_in, before.agent_in,
        "agent input balance changed"
    );
    assert_eq!(
        after.agent_out, before.agent_out,
        "agent output balance changed"
    );
    assert_eq!(
        after.delegated, before.delegated,
        "delegated amount changed"
    );
    assert_eq!(
        after.agent_lamports, before.agent_lamports,
        "agent lamports changed"
    );
    assert_eq!(after.fee, before.fee, "pool fee account changed");
}

fn assert_held(w: &World, before: &Snap, extras: &[(Pubkey, u64)]) {
    assert_unmoved(before, &snap(w));
    for (key, amount) in extras {
        assert_eq!(
            token_amount(&w.svm, key),
            *amount,
            "token account {key} changed"
        );
    }
}

fn create_mint(svm: &mut LiteSVM, payer: &Keypair, decimals: u8, authority: &Pubkey) -> Pubkey {
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
            authority,
            Some(&payer.pubkey()),
            decimals,
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

fn boot() -> (LiteSVM, Keypair, Keypair) {
    let mut svm = LiteSVM::new();
    for bytes in [VETO_BYTES, SWAP_BYTES] {
        let e_flags = u32::from_le_bytes(bytes[48..52].try_into().unwrap());
        assert_eq!(e_flags, 0, "program must be SBPF v0 for LiteSVM 0.10");
    }
    svm.add_program(veto::id(), VETO_BYTES)
        .expect("veto program loads");
    svm.add_program(token_swap_id(), SWAP_BYTES)
        .expect("token-swap program loads");
    let owner = Keypair::new();
    let agent = Keypair::new();
    svm.airdrop(&owner.pubkey(), 100_000_000_000).unwrap();
    svm.airdrop(&agent.pubkey(), 100_000_000_000).unwrap();
    warp(&mut svm, 1_700_000_000);
    (svm, owner, agent)
}

fn create_pool(
    svm: &mut LiteSVM,
    payer: &Keypair,
    in_mint: &Pubkey,
    out_mint: &Pubkey,
    liq_in: u64,
    liq_out: u64,
) -> Pool {
    let exchange_program = token_swap_id();
    let swap_kp = Keypair::new();
    let pool = swap_kp.pubkey();
    let (authority, bump) = Pubkey::find_program_address(&[pool.as_ref()], &exchange_program);
    let vault_in = create_token_account(svm, payer, in_mint, &authority);
    let vault_out = create_token_account(svm, payer, out_mint, &authority);
    mint_to(svm, payer, in_mint, &vault_in, liq_in);
    mint_to(svm, payer, out_mint, &vault_out, liq_out);

    let pool_mint_kp = Keypair::new();
    let pool_mint = pool_mint_kp.pubkey();
    send(
        svm,
        payer,
        &[payer, &pool_mint_kp],
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
                IN_DECIMALS,
            )
            .unwrap(),
        ],
    )
    .expect("create pool mint");

    let fee_account = create_token_account(svm, payer, &pool_mint, &fee_owner());
    let lp_dest = create_token_account(svm, payer, &pool_mint, &payer.pubkey());
    let init = Instruction {
        program_id: exchange_program,
        accounts: vec![
            AccountMeta::new(pool, true),
            AccountMeta::new_readonly(authority, false),
            AccountMeta::new_readonly(vault_in, false),
            AccountMeta::new_readonly(vault_out, false),
            AccountMeta::new(pool_mint, false),
            AccountMeta::new_readonly(fee_account, false),
            AccountMeta::new(lp_dest, false),
            AccountMeta::new_readonly(spl_token::ID, false),
        ],
        data: initialize_data(bump, &ENFORCED_FEES),
    };
    send(
        svm,
        payer,
        &[payer, &swap_kp],
        &[
            system_instruction::create_account(
                &payer.pubkey(),
                &pool,
                10_000_000,
                SWAP_ACCOUNT_LEN,
                &exchange_program,
            ),
            init,
        ],
    )
    .expect("initialize pool");

    let fee = token_account(svm, &fee_account);
    assert_eq!(fee.owner, fee_owner(), "fee account owner");
    assert_eq!(fee.mint, pool_mint);
    assert_eq!(
        svm.get_account(&pool).expect("pool exists").owner,
        exchange_program
    );

    Pool {
        pool,
        authority,
        vault_in,
        vault_out,
        pool_mint,
        fee_account,
    }
}

fn rule_pdas(owner: &Pubkey, rule_id: u64) -> (Pubkey, Pubkey) {
    let (rule, _) = Pubkey::find_program_address(
        &[b"trade", owner.as_ref(), &rule_id.to_le_bytes()],
        &veto::id(),
    );
    let (ledger, _) = Pubkey::find_program_address(&[b"trade-ledger", rule.as_ref()], &veto::id());
    (rule, ledger)
}

fn open_ix(
    owner: Pubkey,
    rules: &Rules,
    agent: Pubkey,
    source: Pubkey,
    destination: Pubkey,
    in_mint: Pubkey,
    out_mint: Pubkey,
    pool: &Pool,
) -> Instruction {
    let (rule, ledger) = rule_pdas(&owner, rules.rule_id);
    Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::OpenTradeRule {
            args: OpenTradeRuleArgs {
                rule_id: rules.rule_id,
                agent,
                exchange_kind: EXCHANGE_KIND_SPL_TOKEN_SWAP,
                cap: rules.cap,
                per_trade_max: rules.per_trade_max,
                daily_limit: rules.daily_limit,
                floor_num: rules.floor_num,
                floor_den: rules.floor_den,
                expires_at: rules.expires_at,
                purpose: rules.purpose.to_string(),
            },
        }
        .data(),
        veto::accounts::OpenTradeRule {
            owner,
            rule,
            ledger,
            source,
            destination,
            in_mint,
            out_mint,
            exchange_program: token_swap_id(),
            pool: pool.pool,
            pool_authority: pool.authority,
            pool_in_vault: pool.vault_in,
            pool_out_vault: pool.vault_out,
            pool_mint: pool.pool_mint,
            pool_fee_account: pool.fee_account,
            token_program: spl_token::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn open_world(rules: Rules) -> World {
    let (mut svm, owner, agent) = boot();
    let in_mint = create_mint(&mut svm, &owner, IN_DECIMALS, &owner.pubkey());
    let out_mint = create_mint(&mut svm, &owner, OUT_DECIMALS, &owner.pubkey());
    let pool = create_pool(
        &mut svm,
        &owner,
        &in_mint,
        &out_mint,
        LIQUIDITY_IN,
        LIQUIDITY_OUT,
    );
    let source = create_token_account(&mut svm, &owner, &in_mint, &owner.pubkey());
    let destination = create_token_account(&mut svm, &owner, &out_mint, &owner.pubkey());
    mint_to(&mut svm, &owner, &in_mint, &source, USER_FUNDS);
    let agent_in = create_token_account(&mut svm, &owner, &in_mint, &agent.pubkey());
    let agent_out = create_token_account(&mut svm, &owner, &out_mint, &agent.pubkey());
    mint_to(&mut svm, &owner, &in_mint, &agent_in, 1);
    mint_to(&mut svm, &owner, &out_mint, &agent_out, 1);

    let (rule, ledger) = rule_pdas(&owner.pubkey(), rules.rule_id);
    let ix = open_ix(
        owner.pubkey(),
        &rules,
        agent.pubkey(),
        source,
        destination,
        in_mint,
        out_mint,
        &pool,
    );
    send(&mut svm, &owner, &[&owner], &[ix]).expect("open trade rule");

    let delegated = token_account(&svm, &source);
    assert_eq!(delegated.delegate, COption::Some(rule));
    assert_eq!(delegated.delegated_amount, rules.cap);
    assert_eq!(delegated.owner, owner.pubkey());

    World {
        svm,
        owner,
        agent,
        in_mint,
        out_mint,
        source,
        destination,
        agent_in,
        agent_out,
        exchange_program: token_swap_id(),
        pool,
        rule,
        ledger,
    }
}

impl TradeIx {
    fn honest(w: &World) -> Self {
        Self {
            agent: w.agent.pubkey(),
            rule: w.rule,
            ledger: w.ledger,
            source: w.source,
            destination: w.destination,
            exchange_program: w.exchange_program,
            pool: w.pool.pool,
            pool_authority: w.pool.authority,
            pool_in_vault: w.pool.vault_in,
            pool_out_vault: w.pool.vault_out,
            pool_mint: w.pool.pool_mint,
            pool_fee_account: w.pool.fee_account,
            token_program: spl_token::ID,
        }
    }

    fn build(&self, amount_in: u64, min_out: u64, nonce: u64) -> Instruction {
        Instruction::new_with_bytes(
            veto::id(),
            &veto::instruction::Trade {
                amount_in,
                min_out,
                nonce,
            }
            .data(),
            veto::accounts::Trade {
                agent: self.agent,
                rule: self.rule,
                ledger: self.ledger,
                source: self.source,
                destination: self.destination,
                exchange_program: self.exchange_program,
                pool: self.pool,
                pool_authority: self.pool_authority,
                pool_in_vault: self.pool_in_vault,
                pool_out_vault: self.pool_out_vault,
                pool_mint: self.pool_mint,
                pool_fee_account: self.pool_fee_account,
                token_program: self.token_program,
            }
            .to_account_metas(None),
        )
    }
}

fn submit(w: &mut World, ix: Instruction) -> Result<litesvm::types::TransactionMetadata, String> {
    let owner = w.owner.insecure_clone();
    let agent = w.agent.insecure_clone();
    send(&mut w.svm, &owner, &[&owner, &agent], &[ix])
}

fn submit_payer(
    w: &mut World,
    payer: &Keypair,
    signers: &[&Keypair],
    ix: Instruction,
) -> Result<litesvm::types::TransactionMetadata, String> {
    send(&mut w.svm, payer, signers, &[ix])
}

fn trade(
    w: &mut World,
    amount_in: u64,
    min_out: u64,
    nonce: u64,
) -> Result<litesvm::types::TransactionMetadata, String> {
    submit(w, TradeIx::honest(w).build(amount_in, min_out, nonce))
}

fn grant(
    w: &mut World,
    amount_in: u64,
    nonce: u64,
) -> Result<litesvm::types::TransactionMetadata, String> {
    let owner = w.owner.insecure_clone();
    let ix = Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::GrantTradeOverride { amount_in, nonce }.data(),
        veto::accounts::GrantTradeOverride {
            owner: owner.pubkey(),
            rule: w.rule,
            ledger: w.ledger,
        }
        .to_account_metas(None),
    );
    send(&mut w.svm, &owner, &[&owner], &[ix])
}

fn revoke(w: &mut World) -> Result<litesvm::types::TransactionMetadata, String> {
    let owner = w.owner.insecure_clone();
    let ix = Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::RevokeTradeRule {}.data(),
        veto::accounts::RevokeTradeRule {
            owner: owner.pubkey(),
            rule: w.rule,
            ledger: w.ledger,
            source: w.source,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
    );
    send(&mut w.svm, &owner, &[&owner], &[ix])
}

fn assert_refused(w: &World, before: &Snap, reason: u8, tried: Pubkey, amount_in: u64, nonce: u64) {
    assert_unmoved(before, &snap(w));
    let entry = last_entry(&w.svm, &w.ledger);
    assert_eq!(entry.kind, TRADE_KIND_REFUSED, "ledger kind");
    assert_eq!(entry.reason, reason, "ledger reason");
    assert_eq!(entry.counterparty, tried, "tried account");
    assert_eq!(entry.amount_in, amount_in);
    assert_eq!(entry.amount_out, 0);
    assert_eq!(entry.nonce, nonce);
}

fn assert_no_new_entry(w: &World, before_total: u32) {
    assert_eq!(read_ledger(&w.svm, &w.ledger).total, before_total);
}

fn optimistic_quote(amount_in: u64, in_reserve: u64, out_reserve: u64) -> u64 {
    let amount = u128::from(amount_in);
    let denom = u128::from(in_reserve).saturating_add(amount);
    u64::try_from(amount.saturating_mul(u128::from(out_reserve)) / denom).unwrap()
}

fn direct_swap(
    svm: &mut LiteSVM,
    payer: &Keypair,
    authority: &Keypair,
    pool: &Pool,
    user_source: Pubkey,
    user_dest: Pubkey,
    amount_in: u64,
    minimum_out: u64,
) -> Result<litesvm::types::TransactionMetadata, String> {
    let mut data = Vec::with_capacity(17);
    data.push(1);
    push_u64(&mut data, amount_in);
    push_u64(&mut data, minimum_out);
    let ix = Instruction {
        program_id: token_swap_id(),
        accounts: vec![
            AccountMeta::new_readonly(pool.pool, false),
            AccountMeta::new_readonly(pool.authority, false),
            AccountMeta::new_readonly(authority.pubkey(), true),
            AccountMeta::new(user_source, false),
            AccountMeta::new(pool.vault_in, false),
            AccountMeta::new(pool.vault_out, false),
            AccountMeta::new(user_dest, false),
            AccountMeta::new(pool.pool_mint, false),
            AccountMeta::new(pool.fee_account, false),
            AccountMeta::new_readonly(spl_token::ID, false),
        ],
        data,
    };
    if payer.pubkey() == authority.pubkey() {
        send(svm, payer, &[payer], &[ix])
    } else {
        send(svm, payer, &[payer, authority], &[ix])
    }
}

fn plant(svm: &mut LiteSVM, key: Pubkey, lamports: u64, data: Vec<u8>) {
    svm.set_account(
        key,
        Account {
            lamports,
            data,
            owner: veto::id(),
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn window_sum(trades: &[(i64, u64)], start: i64) -> u64 {
    trades
        .iter()
        .filter(|(ts, _)| *ts >= start && *ts < start + TRADE_WINDOW_SECS)
        .map(|(_, amount)| *amount)
        .fold(0u64, |acc, amount| {
            acc.checked_add(amount).expect("window sum fits")
        })
}

// ---------------------------------------------------------------------------
// Destination.
// ---------------------------------------------------------------------------

#[test]
fn output_to_an_agent_owned_account_of_the_right_mint_is_reason_11() {
    let mut w = open_world(Rules::default());
    let amount_in = 10 * IN_ONE;
    let before = snap(&w);
    let agent_out_before = token_amount(&w.svm, &w.agent_out);
    let ix = TradeIx {
        destination: w.agent_out,
        ..TradeIx::honest(&w)
    }
    .build(amount_in, 1, 1);
    submit(&mut w, ix).expect("refusal confirms");
    assert_refused(
        &w,
        &before,
        REASON_DESTINATION_NOT_ALLOWED,
        w.agent_out,
        amount_in,
        1,
    );
    assert_eq!(token_amount(&w.svm, &w.agent_out), agent_out_before);
    assert_eq!(read_rule(&w.svm, &w.rule).last_nonce, 0);
}

#[test]
fn output_to_an_owner_account_that_is_not_the_pinned_one_is_reason_11() {
    let mut w = open_world(Rules::default());
    let owner = w.owner.insecure_clone();
    let other = create_token_account(&mut w.svm, &owner, &w.out_mint, &owner.pubkey());
    let amount_in = 10 * IN_ONE;
    let before = snap(&w);
    let other_before = token_amount(&w.svm, &other);
    let ix = TradeIx {
        destination: other,
        ..TradeIx::honest(&w)
    }
    .build(amount_in, 1, 1);
    submit(&mut w, ix).expect("refusal confirms");
    assert_refused(
        &w,
        &before,
        REASON_DESTINATION_NOT_ALLOWED,
        other,
        amount_in,
        1,
    );
    assert_eq!(token_account(&w.svm, &other).owner, owner.pubkey());
    assert_eq!(token_amount(&w.svm, &other), other_before);
}

#[test]
fn output_account_with_the_wrong_mint_is_reason_11_because_the_key_is_not_pinned() {
    let mut w = open_world(Rules::default());
    let owner = w.owner.insecure_clone();
    let wrong_mint = create_token_account(&mut w.svm, &owner, &w.in_mint, &owner.pubkey());
    let amount_in = 10 * IN_ONE;
    let before = snap(&w);
    let wrong_before = token_amount(&w.svm, &wrong_mint);
    assert_ne!(token_account(&w.svm, &wrong_mint).mint, w.out_mint);
    let ix = TradeIx {
        destination: wrong_mint,
        ..TradeIx::honest(&w)
    }
    .build(amount_in, 1, 1);
    submit(&mut w, ix).expect("refusal confirms");
    assert_refused(
        &w,
        &before,
        REASON_DESTINATION_NOT_ALLOWED,
        wrong_mint,
        amount_in,
        1,
    );
    assert_eq!(token_amount(&w.svm, &wrong_mint), wrong_before);
}

// ---------------------------------------------------------------------------
// Pool substitution.
// ---------------------------------------------------------------------------

#[test]
fn an_attacker_pool_at_a_1_to_1000_rate_is_reason_12_and_names_that_pool() {
    let mut w = open_world(Rules::default());
    let owner = w.owner.insecure_clone();
    let liq_in = 250_000 * IN_ONE;
    let liq_out = liq_in * 1_000;
    let attacker_pool = create_pool(&mut w.svm, &owner, &w.in_mint, &w.out_mint, liq_in, liq_out);
    assert_eq!(
        token_amount(&w.svm, &attacker_pool.vault_out)
            / token_amount(&w.svm, &attacker_pool.vault_in),
        1_000,
        "attacker pool reserves are 1:1000"
    );
    let amount_in = 10 * IN_ONE;
    let before = snap(&w);
    let attacker_in_before = token_amount(&w.svm, &attacker_pool.vault_in);
    let attacker_out_before = token_amount(&w.svm, &attacker_pool.vault_out);
    let ix = TradeIx {
        pool: attacker_pool.pool,
        pool_authority: attacker_pool.authority,
        pool_in_vault: attacker_pool.vault_in,
        pool_out_vault: attacker_pool.vault_out,
        pool_mint: attacker_pool.pool_mint,
        pool_fee_account: attacker_pool.fee_account,
        ..TradeIx::honest(&w)
    }
    .build(amount_in, 1, 1);
    submit(&mut w, ix).expect("refusal confirms");
    assert_refused(
        &w,
        &before,
        REASON_POOL_NOT_ALLOWED,
        attacker_pool.pool,
        amount_in,
        1,
    );
    assert_eq!(
        token_amount(&w.svm, &attacker_pool.vault_in),
        attacker_in_before
    );
    assert_eq!(
        token_amount(&w.svm, &attacker_pool.vault_out),
        attacker_out_before
    );
}

#[test]
fn the_correct_pool_key_with_one_substituted_vault_mint_or_fee_account_is_reason_12() {
    let mut w = open_world(Rules::default());
    let owner = w.owner.insecure_clone();
    let agent = w.agent.pubkey();
    let fake_vault = create_token_account(&mut w.svm, &owner, &w.out_mint, &agent);
    let fake_mint = create_mint(&mut w.svm, &owner, IN_DECIMALS, &owner.pubkey());
    let owner_fee = create_token_account(&mut w.svm, &owner, &w.pool.pool_mint, &owner.pubkey());
    let amount_in = 10 * IN_ONE;

    let cases = [
        ("vault", fake_vault, "pool_out_vault"),
        ("pool mint", fake_mint, "pool_mint"),
        ("fee account", owner_fee, "pool_fee_account"),
    ];
    for (label, substituted, which) in cases {
        let mut ix = TradeIx::honest(&w);
        match which {
            "pool_out_vault" => ix.pool_out_vault = substituted,
            "pool_mint" => ix.pool_mint = substituted,
            "pool_fee_account" => ix.pool_fee_account = substituted,
            _ => unreachable!(),
        }
        assert_eq!(ix.pool, w.pool.pool, "{label} keeps the pinned pool key");
        let before = snap(&w);
        let data_before = w.svm.get_account(&substituted).unwrap().data.clone();
        let total = read_ledger(&w.svm, &w.ledger).total;
        submit(&mut w, ix.build(amount_in, 1, 1)).unwrap_or_else(|err| {
            panic!("{label} substitution should confirm as a refusal, got:\n{err}")
        });
        assert_refused(
            &w,
            &before,
            REASON_POOL_NOT_ALLOWED,
            substituted,
            amount_in,
            1,
        );
        assert_eq!(read_ledger(&w.svm, &w.ledger).total, total + 1, "{label}");
        assert_eq!(
            w.svm.get_account(&substituted).unwrap().data,
            data_before,
            "{label} account data changed"
        );
        assert_eq!(read_rule(&w.svm, &w.rule).last_nonce, 0, "{label}");
    }
}

#[test]
fn an_appended_host_fee_account_errors_and_substituting_it_as_the_fee_account_is_reason_12() {
    let mut w = open_world(Rules::default());
    let owner = w.owner.insecure_clone();
    let host = create_token_account(&mut w.svm, &owner, &w.pool.pool_mint, &w.agent.pubkey());
    assert_eq!(token_account(&w.svm, &host).owner, w.agent.pubkey());
    assert_eq!(token_account(&w.svm, &host).mint, w.pool.pool_mint);
    let amount_in = 10 * IN_ONE;

    let mut appended = TradeIx::honest(&w).build(amount_in, 1, 1);
    appended.accounts.push(AccountMeta::new(host, false));
    let before = snap(&w);
    let total = read_ledger(&w.svm, &w.ledger).total;
    assert_err(submit(&mut w, appended), "UnexpectedTradeAccount");
    assert_held(&w, &before, &[(host, 0)]);
    assert_no_new_entry(&w, total);

    let ix = TradeIx {
        pool_fee_account: host,
        ..TradeIx::honest(&w)
    }
    .build(amount_in, 1, 2);
    let before = snap(&w);
    submit(&mut w, ix).expect("fee substitution confirms as a refusal");
    assert_refused(&w, &before, REASON_POOL_NOT_ALLOWED, host, amount_in, 2);
    assert_eq!(token_amount(&w.svm, &host), 0);
}

// ---------------------------------------------------------------------------
// Limits, floor, delegation, nonce, override, revoke, expiry.
// ---------------------------------------------------------------------------

#[test]
fn over_the_per_trade_maximum_is_reason_5_and_suggests_that_amount() {
    let mut w = open_world(Rules::default());
    let amount_in = 30 * IN_ONE;
    let before = snap(&w);
    trade(&mut w, amount_in, 1, 1).expect("refusal confirms");
    assert_refused(
        &w,
        &before,
        REASON_OVER_PER_TX_MAX,
        w.pool.pool,
        amount_in,
        1,
    );
    assert_eq!(last_entry(&w.svm, &w.ledger).suggested_override, amount_in);
    assert!(amount_in <= Rules::default().daily_limit);
    assert!(amount_in <= Rules::default().cap);
}

#[test]
fn trades_fill_the_daily_limit_then_the_next_is_reason_13_until_the_window_rolls() {
    let mut w = open_world(Rules {
        cap: 200 * IN_ONE,
        per_trade_max: 20 * IN_ONE,
        daily_limit: 50 * IN_ONE,
        ..Rules::default()
    });
    let mut paid: Vec<(i64, u64)> = Vec::new();
    for (nonce, amount) in [(1u64, 20 * IN_ONE), (2, 20 * IN_ONE), (3, 10 * IN_ONE)] {
        let before = snap(&w);
        trade(&mut w, amount, 1, nonce).expect("trade inside the daily limit pays");
        let after = snap(&w);
        assert_eq!(before.source - after.source, amount);
        assert_eq!(before.delegated - after.delegated, amount);
        assert_eq!(after.agent_in, before.agent_in);
        assert_eq!(after.agent_out, before.agent_out);
        paid.push((now(&w.svm), amount));
    }
    assert_eq!(read_rule(&w.svm, &w.rule).window_spent, 50 * IN_ONE);

    let next = 10 * IN_ONE;
    let before = snap(&w);
    trade(&mut w, next, 1, 4).expect("over the daily limit confirms");
    assert_refused(&w, &before, REASON_OVER_DAILY, w.pool.pool, next, 4);

    let start = read_rule(&w.svm, &w.rule).window_start;
    warp(&mut w.svm, start + TRADE_WINDOW_SECS - 1);
    let before = snap(&w);
    trade(&mut w, 1, 1, 5).expect("one second before the roll still refuses");
    assert_refused(&w, &before, REASON_OVER_DAILY, w.pool.pool, 1, 5);
    assert_eq!(read_rule(&w.svm, &w.rule).window_start, start);

    warp(&mut w.svm, start + TRADE_WINDOW_SECS);
    let again = 20 * IN_ONE;
    let before = snap(&w);
    trade(&mut w, again, 1, 6).expect("a new window allows another trade");
    let after = snap(&w);
    assert_eq!(before.source - after.source, again);
    assert_eq!(after.agent_in, before.agent_in);
    assert_eq!(after.agent_out, before.agent_out);
    paid.push((now(&w.svm), again));

    let limit = 50 * IN_ONE;
    for (ts, _) in &paid {
        let sum = window_sum(&paid, *ts);
        assert!(
            sum <= limit,
            "input {sum} in the 24 hour window starting {ts} exceeds {limit}"
        );
    }
    let debited: u64 = paid.iter().map(|(_, amount)| amount).sum();
    assert_eq!(USER_FUNDS - token_amount(&w.svm, &w.source), debited);
    assert_eq!(read_rule(&w.svm, &w.rule).spent, debited);
}

#[test]
fn over_the_remaining_cap_is_reason_6_and_an_override_cannot_clear_it() {
    let mut w = open_world(Rules {
        cap: 40 * IN_ONE,
        per_trade_max: 10 * IN_ONE,
        daily_limit: 40 * IN_ONE,
        ..Rules::default()
    });
    grant(&mut w, 30 * IN_ONE, 9).expect("override granted while the cap can hold it");
    trade(&mut w, 10 * IN_ONE, 1, 1).expect("pays");
    trade(&mut w, 10 * IN_ONE, 1, 2).expect("pays");
    trade(&mut w, 10 * IN_ONE, 1, 3).expect("pays");
    assert_eq!(read_rule(&w.svm, &w.rule).remaining(), 10 * IN_ONE);
    let start = read_rule(&w.svm, &w.rule).window_start;
    warp(&mut w.svm, start + TRADE_WINDOW_SECS);

    let amount_in = 20 * IN_ONE;
    let before = snap(&w);
    let total = read_ledger(&w.svm, &w.ledger).total;
    trade(&mut w, amount_in, 1, 9).expect("over the remaining cap confirms");
    assert_refused(&w, &before, REASON_OVER_CAP, w.pool.pool, amount_in, 9);
    assert_eq!(last_entry(&w.svm, &w.ledger).suggested_override, 0);
    assert_eq!(read_rule(&w.svm, &w.rule).override_nonce, 9);
    assert_eq!(read_rule(&w.svm, &w.rule).override_amount, 30 * IN_ONE);

    let before = snap(&w);
    assert_err(grant(&mut w, amount_in, 10), "OverrideAboveCap");
    assert_held(&w, &before, &[]);
    assert_no_new_entry(&w, total + 1);
    assert_eq!(read_rule(&w.svm, &w.rule).spent, 30 * IN_ONE);
}

#[test]
fn a_pool_drained_on_the_output_side_by_a_third_party_is_reason_14() {
    let mut w = open_world(Rules {
        floor_num: 500,
        floor_den: 1,
        ..Rules::default()
    });
    let amount_in = 10 * IN_ONE;
    let quote_before = optimistic_quote(
        amount_in,
        token_amount(&w.svm, &w.pool.vault_in),
        token_amount(&w.svm, &w.pool.vault_out),
    );
    assert!(
        quote_before >= amount_in * 500,
        "floor was already impossible before the drain, quote {quote_before}"
    );

    let third = Keypair::new();
    w.svm.airdrop(&third.pubkey(), 10_000_000_000).unwrap();
    let owner = w.owner.insecure_clone();
    let third_in = create_token_account(&mut w.svm, &owner, &w.in_mint, &third.pubkey());
    let third_out = create_token_account(&mut w.svm, &owner, &w.out_mint, &third.pubkey());
    let drain = 500_000 * IN_ONE;
    mint_to(&mut w.svm, &owner, &w.in_mint, &third_in, drain);
    let owner_source_before = token_amount(&w.svm, &w.source);
    direct_swap(
        &mut w.svm, &third, &third, &w.pool, third_in, third_out, drain, 1,
    )
    .expect("third party drains the output vault");
    assert_eq!(token_amount(&w.svm, &w.source), owner_source_before);
    assert!(token_amount(&w.svm, &third_out) > 0);

    let quote_after = optimistic_quote(
        amount_in,
        token_amount(&w.svm, &w.pool.vault_in),
        token_amount(&w.svm, &w.pool.vault_out),
    );
    assert!(
        u128::from(quote_after) < u128::from(amount_in) * 500,
        "drain left the quote at {quote_after}, still at or above the floor"
    );

    let before = snap(&w);
    trade(&mut w, amount_in, 1, 1).expect("below-floor refusal confirms");
    assert_refused(
        &w,
        &before,
        veto::REASON_BELOW_FLOOR,
        w.pool.pool,
        amount_in,
        1,
    );
    assert_eq!(token_amount(&w.svm, &w.agent_out), before.agent_out);
}

#[test]
fn a_quote_that_clears_the_floor_but_the_exchange_fee_does_not_is_rejected_with_no_entry() {
    let amount_in = 10 * IN_ONE;
    let quote = optimistic_quote(amount_in, LIQUIDITY_IN, LIQUIDITY_OUT);
    let mut w = open_world(Rules {
        floor_num: quote,
        floor_den: amount_in,
        ..Rules::default()
    });
    assert_eq!(token_amount(&w.svm, &w.pool.vault_in), LIQUIDITY_IN);
    assert_eq!(token_amount(&w.svm, &w.pool.vault_out), LIQUIDITY_OUT);
    let seen = optimistic_quote(amount_in, LIQUIDITY_IN, LIQUIDITY_OUT);
    assert_eq!(seen, quote);
    assert!(
        u128::from(seen) * u128::from(amount_in) >= u128::from(amount_in) * u128::from(quote),
        "the optimistic quote must clear this floor"
    );

    let before = snap(&w);
    let total = read_ledger(&w.svm, &w.ledger).total;
    let opened = last_entry(&w.svm, &w.ledger);
    assert_eq!(opened.kind, TRADE_KIND_OPENED);
    assert_err(
        trade(&mut w, amount_in, 1, 1),
        "exceeds desired slippage limit",
    );
    assert_held(&w, &before, &[]);
    assert_no_new_entry(&w, total);
    assert_eq!(last_entry(&w.svm, &w.ledger).kind, TRADE_KIND_OPENED);
    assert_eq!(last_entry(&w.svm, &w.ledger).reason, REASON_OK);
    assert_eq!(read_rule(&w.svm, &w.rule).trade_count, 0);
    assert_eq!(read_rule(&w.svm, &w.rule).refusal_count, 0);
}

#[test]
fn the_owner_revoking_the_spl_delegation_directly_is_reason_7() {
    let mut w = open_world(Rules::default());
    let owner = w.owner.insecure_clone();
    send(
        &mut w.svm,
        &owner,
        &[&owner],
        &[
            spl_token::instruction::revoke(&spl_token::ID, &w.source, &owner.pubkey(), &[])
                .unwrap(),
        ],
    )
    .expect("owner revokes the delegation directly");
    assert_eq!(token_account(&w.svm, &w.source).delegate, COption::None);
    assert_eq!(read_rule(&w.svm, &w.rule).status, STATUS_ACTIVE);

    let amount_in = 10 * IN_ONE;
    let before = snap(&w);
    trade(&mut w, amount_in, 1, 1).expect("refusal confirms");
    assert_refused(
        &w,
        &before,
        REASON_DELEGATE_MISSING,
        w.pool.pool,
        amount_in,
        1,
    );
    assert_eq!(token_account(&w.svm, &w.source).delegate, COption::None);
}

#[test]
fn a_replayed_nonce_is_reason_3_and_a_refused_nonce_trades_after_an_override() {
    let mut w = open_world(Rules::default());
    trade(&mut w, 10 * IN_ONE, 1, 1).expect("first trade pays");
    let before = snap(&w);
    trade(&mut w, 10 * IN_ONE, 1, 1).expect("replay confirms");
    assert_refused(&w, &before, REASON_STALE_NONCE, w.pool.pool, 10 * IN_ONE, 1);
    assert_eq!(read_rule(&w.svm, &w.rule).last_nonce, 1);

    let amount_in = 30 * IN_ONE;
    let before = snap(&w);
    trade(&mut w, amount_in, 1, 2).expect("over-max refusal confirms");
    assert_refused(
        &w,
        &before,
        REASON_OVER_PER_TX_MAX,
        w.pool.pool,
        amount_in,
        2,
    );
    assert_eq!(read_rule(&w.svm, &w.rule).last_nonce, 1);

    grant(&mut w, amount_in, 2).expect("override for the refused nonce");
    let before = snap(&w);
    trade(&mut w, amount_in, 1, 2).expect("the refused nonce trades after the override");
    let after = snap(&w);
    assert_eq!(before.source - after.source, amount_in);
    assert!(after.destination >= before.destination);
    assert_eq!(before.delegated - after.delegated, amount_in);
    assert_eq!(after.agent_in, before.agent_in);
    assert_eq!(after.agent_out, before.agent_out);
    let rule = read_rule(&w.svm, &w.rule);
    assert_eq!(rule.last_nonce, 2);
    assert_eq!(rule.override_nonce, 0);
    assert_eq!(last_entry(&w.svm, &w.ledger).kind, TRADE_KIND_TRADED);
    assert_eq!(
        last_entry(&w.svm, &w.ledger).amount_in,
        before.source - after.source
    );
}

#[test]
fn an_override_trades_over_the_per_trade_maximum_and_does_not_lift_daily_or_cap() {
    let mut w = open_world(Rules {
        cap: 50 * IN_ONE,
        per_trade_max: 10 * IN_ONE,
        daily_limit: 30 * IN_ONE,
        ..Rules::default()
    });
    grant(&mut w, 40 * IN_ONE, 8).expect("override granted");

    let over_day = 40 * IN_ONE;
    let before = snap(&w);
    trade(&mut w, over_day, 1, 8).expect("daily refusal confirms");
    assert_refused(&w, &before, REASON_OVER_DAILY, w.pool.pool, over_day, 8);
    assert_eq!(read_rule(&w.svm, &w.rule).override_nonce, 8);

    trade(&mut w, 10 * IN_ONE, 1, 1).expect("pays");
    trade(&mut w, 10 * IN_ONE, 1, 2).expect("pays");
    trade(&mut w, 10 * IN_ONE, 1, 3).expect("pays");
    assert_eq!(read_rule(&w.svm, &w.rule).spent, 30 * IN_ONE);
    let start = read_rule(&w.svm, &w.rule).window_start;
    warp(&mut w.svm, start + TRADE_WINDOW_SECS);

    let over_cap = 25 * IN_ONE;
    let before = snap(&w);
    trade(&mut w, over_cap, 1, 8).expect("cap refusal confirms");
    assert_refused(&w, &before, REASON_OVER_CAP, w.pool.pool, over_cap, 8);
    assert_eq!(read_rule(&w.svm, &w.rule).override_nonce, 8);
    assert_eq!(read_rule(&w.svm, &w.rule).spent, 30 * IN_ONE);

    let lifted = 20 * IN_ONE;
    let before = snap(&w);
    trade(&mut w, lifted, 1, 8).expect("override trades over the per-trade maximum");
    let after = snap(&w);
    assert_eq!(before.source - after.source, lifted);
    assert!(after.destination - before.destination >= 1);
    assert_eq!(before.delegated - after.delegated, lifted);
    assert_eq!(after.agent_in, before.agent_in);
    assert_eq!(after.agent_out, before.agent_out);
    let rule = read_rule(&w.svm, &w.rule);
    assert_eq!(rule.spent, 50 * IN_ONE);
    assert_eq!(rule.last_nonce, 8);
    assert_eq!(rule.override_nonce, 0);
    assert_eq!(rule.override_amount, 0);
    assert_eq!(last_entry(&w.svm, &w.ledger).kind, TRADE_KIND_TRADED);
    assert_eq!(last_entry(&w.svm, &w.ledger).amount_in, lifted);
    assert_eq!(
        last_entry(&w.svm, &w.ledger).amount_out,
        after.destination - before.destination
    );
}

#[test]
fn revoke_then_trade_is_reason_1_and_the_delegate_is_cleared() {
    let mut w = open_world(Rules::default());
    let before_revoke = snap(&w);
    revoke(&mut w).expect("revoke");
    assert_eq!(token_amount(&w.svm, &w.source), before_revoke.source);
    assert_eq!(token_account(&w.svm, &w.source).delegate, COption::None);
    assert_eq!(read_rule(&w.svm, &w.rule).status, STATUS_REVOKED);

    let amount_in = 10 * IN_ONE;
    let before = snap(&w);
    trade(&mut w, amount_in, 1, 1).expect("refusal confirms");
    assert_refused(&w, &before, REASON_NOT_ACTIVE, w.pool.pool, amount_in, 1);
    assert_eq!(token_account(&w.svm, &w.source).delegate, COption::None);
    assert_eq!(read_rule(&w.svm, &w.rule).status, STATUS_REVOKED);
}

#[test]
fn expiry_is_reason_2_and_the_status_flips_exactly_once() {
    let opened_at = now(&open_world(Rules::default()).svm);
    let mut w = open_world(Rules {
        expires_at: opened_at + 60,
        ..Rules::default()
    });
    assert_eq!(read_rule(&w.svm, &w.rule).status, STATUS_ACTIVE);
    warp(&mut w.svm, opened_at + 60);

    let amount_in = 10 * IN_ONE;
    let before = snap(&w);
    trade(&mut w, amount_in, 1, 1).expect("expiry refusal confirms");
    assert_refused(&w, &before, REASON_EXPIRED, w.pool.pool, amount_in, 1);
    assert_eq!(read_rule(&w.svm, &w.rule).status, STATUS_EXPIRED);

    let before = snap(&w);
    trade(&mut w, amount_in, 1, 2).expect("second attempt confirms");
    assert_refused(&w, &before, REASON_NOT_ACTIVE, w.pool.pool, amount_in, 2);
    assert_eq!(read_rule(&w.svm, &w.rule).status, STATUS_EXPIRED);
    assert_eq!(read_rule(&w.svm, &w.rule).refusal_count, 2);
}

// ---------------------------------------------------------------------------
// Account constraints.
// ---------------------------------------------------------------------------

#[test]
fn a_wrong_signer_a_forged_rule_another_ledger_or_a_mandate_is_rejected() {
    let mut w = open_world(Rules::default());
    let amount_in = 10 * IN_ONE;

    let stranger = Keypair::new();
    w.svm.airdrop(&stranger.pubkey(), 10_000_000_000).unwrap();
    let before = snap(&w);
    let total = read_ledger(&w.svm, &w.ledger).total;
    let ix = TradeIx {
        agent: stranger.pubkey(),
        ..TradeIx::honest(&w)
    }
    .build(amount_in, 1, 1);
    assert_err(
        submit_payer(&mut w, &stranger, &[&stranger], ix),
        "NotTheAgent",
    );
    assert_held(&w, &before, &[]);
    assert_no_new_entry(&w, total);

    let real_rule = w.svm.get_account(&w.rule).unwrap();
    let forged_rule = Pubkey::new_unique();
    plant(
        &mut w.svm,
        forged_rule,
        real_rule.lamports,
        real_rule.data.clone(),
    );
    let (forged_ledger, _) =
        Pubkey::find_program_address(&[b"trade-ledger", forged_rule.as_ref()], &veto::id());
    let real_ledger = w.svm.get_account(&w.ledger).unwrap();
    plant(
        &mut w.svm,
        forged_ledger,
        real_ledger.lamports,
        real_ledger.data.clone(),
    );
    let ix = TradeIx {
        rule: forged_rule,
        ledger: forged_ledger,
        ..TradeIx::honest(&w)
    }
    .build(amount_in, 1, 1);
    let before = snap(&w);
    assert_err(submit(&mut w, ix), "InvalidTradeRulePda");
    assert_held(&w, &before, &[]);
    assert_no_new_entry(&w, total);

    let owner = w.owner.insecure_clone();
    let second_source = create_token_account(&mut w.svm, &owner, &w.in_mint, &owner.pubkey());
    mint_to(&mut w.svm, &owner, &w.in_mint, &second_source, IN_ONE);
    let second = Rules {
        rule_id: 2,
        ..Rules::default()
    };
    let ix = open_ix(
        owner.pubkey(),
        &second,
        w.agent.pubkey(),
        second_source,
        w.destination,
        w.in_mint,
        w.out_mint,
        &w.pool,
    );
    send(&mut w.svm, &owner, &[&owner], &[ix]).expect("second rule opens");
    let (_, ledger2) = rule_pdas(&owner.pubkey(), 2);
    let ix = TradeIx {
        ledger: ledger2,
        ..TradeIx::honest(&w)
    }
    .build(amount_in, 1, 1);
    let before = snap(&w);
    assert_err(submit(&mut w, ix), "ConstraintSeeds");
    assert_held(&w, &before, &[]);
    assert_no_new_entry(&w, total);
    assert_eq!(
        token_account(&w.svm, &w.source).delegate,
        COption::Some(w.rule)
    );

    let mint = create_mint(&mut w.svm, &owner, IN_DECIMALS, &owner.pubkey());
    let mandate_source = create_token_account(&mut w.svm, &owner, &mint, &owner.pubkey());
    let (mandate, mandate_ledger) = {
        let (mandate, _) = Pubkey::find_program_address(
            &[b"mandate", owner.pubkey().as_ref(), &7u64.to_le_bytes()],
            &veto::id(),
        );
        let (ledger, _) = Pubkey::find_program_address(&[b"ledger", mandate.as_ref()], &veto::id());
        (mandate, ledger)
    };
    let open = Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::OpenMandate {
            args: veto::OpenMandateArgs {
                mandate_id: 7,
                agent: w.agent.pubkey(),
                merchant: Pubkey::new_unique(),
                cap: 10,
                per_tx_max: 10,
                expires_at: FAR_FUTURE,
                purpose: "mandate".to_string(),
            },
        }
        .data(),
        veto::accounts::OpenMandate {
            owner: owner.pubkey(),
            mandate,
            ledger: mandate_ledger,
            source: mandate_source,
            mint,
            token_program: spl_token::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(&mut w.svm, &owner, &[&owner], &[open]).expect("open mandate");
    let ix = TradeIx {
        rule: mandate,
        ..TradeIx::honest(&w)
    }
    .build(amount_in, 1, 1);
    let before = snap(&w);
    assert_err(submit(&mut w, ix), "AccountDiscriminatorMismatch");
    assert_held(&w, &before, &[]);
    assert_no_new_entry(&w, total);
}

#[test]
fn token_2022_as_the_token_program_is_a_constraint_error() {
    let mut w = open_world(Rules::default());
    let amount_in = 10 * IN_ONE;
    let before = snap(&w);
    let total = read_ledger(&w.svm, &w.ledger).total;
    let ix = TradeIx {
        token_program: token_2022_id(),
        ..TradeIx::honest(&w)
    }
    .build(amount_in, 1, 1);
    assert_err(submit(&mut w, ix), "InvalidProgramId");
    assert_held(&w, &before, &[]);
    assert_no_new_entry(&w, total);
}

#[test]
fn source_substitution_is_a_has_one_error() {
    let mut w = open_world(Rules::default());
    let owner = w.owner.insecure_clone();
    let other = create_token_account(&mut w.svm, &owner, &w.in_mint, &owner.pubkey());
    mint_to(&mut w.svm, &owner, &w.in_mint, &other, 50 * IN_ONE);
    let amount_in = 10 * IN_ONE;
    let before = snap(&w);
    let other_before = token_amount(&w.svm, &other);
    let total = read_ledger(&w.svm, &w.ledger).total;
    let ix = TradeIx {
        source: other,
        ..TradeIx::honest(&w)
    }
    .build(amount_in, 1, 1);
    assert_err(submit(&mut w, ix), "SourceMismatch");
    assert_held(&w, &before, &[(other, other_before)]);
    assert_no_new_entry(&w, total);
}

#[test]
fn a_paid_trade_debits_the_source_by_the_input_and_records_the_observed_deltas() {
    let mut w = open_world(Rules::default());
    let amount_in = 10 * IN_ONE;
    let min_out = amount_in;
    let before = snap(&w);
    trade(&mut w, amount_in, min_out, 1).expect("paid trade");
    let after = snap(&w);

    assert_eq!(before.source - after.source, amount_in);
    let gained = after.destination - before.destination;
    assert!(gained >= min_out, "destination gained {gained}");
    assert_eq!(before.delegated - after.delegated, amount_in);
    assert_eq!(after.agent_in, before.agent_in);
    assert_eq!(after.agent_out, before.agent_out);
    assert_eq!(after.agent_lamports, before.agent_lamports);
    assert_eq!(after.vault_in, before.vault_in + amount_in);
    assert_eq!(before.vault_out - after.vault_out, gained);

    let entry = last_entry(&w.svm, &w.ledger);
    assert_eq!(entry.kind, TRADE_KIND_TRADED);
    assert_eq!(entry.amount_in, before.source - after.source);
    assert_eq!(entry.amount_out, gained);
    assert_eq!(entry.counterparty, w.pool.pool);
    assert_eq!(entry.reason, REASON_OK);
    let rule = read_rule(&w.svm, &w.rule);
    assert_eq!(rule.spent, amount_in);
    assert_eq!(rule.last_nonce, 1);
}

#[test]
fn open_rejects_a_mismatched_pool_a_foreign_destination_and_limits_out_of_order() {
    let mut w = open_world(Rules::default());
    let owner = w.owner.insecure_clone();
    let delegate_before = token_account(&w.svm, &w.source).delegate;
    let source_before = token_amount(&w.svm, &w.source);

    let swapped = Pool {
        vault_in: w.pool.vault_out,
        vault_out: w.pool.vault_in,
        ..w.pool
    };
    let mismatch = Rules {
        rule_id: 41,
        ..Rules::default()
    };
    let ix = open_ix(
        owner.pubkey(),
        &mismatch,
        w.agent.pubkey(),
        w.source,
        w.destination,
        w.in_mint,
        w.out_mint,
        &swapped,
    );
    assert_err(
        send(&mut w.svm, &owner, &[&owner], &[ix]),
        "PoolAccountMismatch",
    );
    let (rule, _) = rule_pdas(&owner.pubkey(), 41);
    assert!(w.svm.get_account(&rule).is_none());

    let foreign = Rules {
        rule_id: 42,
        ..Rules::default()
    };
    let ix = open_ix(
        owner.pubkey(),
        &foreign,
        w.agent.pubkey(),
        w.source,
        w.agent_out,
        w.in_mint,
        w.out_mint,
        &w.pool,
    );
    assert_err(
        send(&mut w.svm, &owner, &[&owner], &[ix]),
        "DestinationNotOwnedByOwner",
    );
    let (rule, _) = rule_pdas(&owner.pubkey(), 42);
    assert!(w.svm.get_account(&rule).is_none());

    let disordered = Rules {
        rule_id: 43,
        per_trade_max: 80 * IN_ONE,
        daily_limit: 50 * IN_ONE,
        cap: 100 * IN_ONE,
        ..Rules::default()
    };
    let ix = open_ix(
        owner.pubkey(),
        &disordered,
        w.agent.pubkey(),
        w.source,
        w.destination,
        w.in_mint,
        w.out_mint,
        &w.pool,
    );
    assert_err(
        send(&mut w.svm, &owner, &[&owner], &[ix]),
        "TradeLimitsOutOfOrder",
    );
    let (rule, _) = rule_pdas(&owner.pubkey(), 43);
    assert!(w.svm.get_account(&rule).is_none());

    assert_eq!(token_amount(&w.svm, &w.source), source_before);
    assert_eq!(token_account(&w.svm, &w.source).delegate, delegate_before);
    assert_eq!(token_amount(&w.svm, &w.agent_out), 1);
    assert_eq!(read_rule(&w.svm, &w.rule).status, STATUS_ACTIVE);
}

// ---------------------------------------------------------------------------
// Two attacks that were not on the list.
// ---------------------------------------------------------------------------

/// Two trades in one transaction, each small enough for the daily limit on its
/// own, together over it. The second must see the first trade's window spend.
#[test]
fn two_trades_in_one_transaction_cannot_slip_past_the_daily_limit() {
    let mut w = open_world(Rules {
        cap: 100 * IN_ONE,
        per_trade_max: 20 * IN_ONE,
        daily_limit: 30 * IN_ONE,
        ..Rules::default()
    });
    let amount = 20 * IN_ONE;
    let first = TradeIx::honest(&w).build(amount, 1, 1);
    let second = TradeIx::honest(&w).build(amount, 1, 2);
    let before = snap(&w);
    let owner = w.owner.insecure_clone();
    let agent = w.agent.insecure_clone();
    send(&mut w.svm, &owner, &[&owner, &agent], &[first, second])
        .expect("the transaction confirms");
    let after = snap(&w);
    assert_eq!(before.source - after.source, amount);
    assert_eq!(before.delegated - after.delegated, amount);
    assert!(after.destination > before.destination);
    assert_eq!(after.agent_in, before.agent_in);
    assert_eq!(after.agent_out, before.agent_out);
    let rule = read_rule(&w.svm, &w.rule);
    assert_eq!(rule.spent, amount);
    assert_eq!(rule.window_spent, amount);
    assert_eq!(rule.trade_count, 1);
    assert_eq!(rule.refusal_count, 1);
    assert_eq!(rule.last_nonce, 1);
    let ledger = read_ledger(&w.svm, &w.ledger);
    assert_eq!(ledger.total, 3);
    assert_eq!(ledger.entries[1].kind, TRADE_KIND_TRADED);
    assert_eq!(ledger.entries[1].amount_in, amount);
    assert_eq!(
        ledger.entries[1].amount_out,
        after.destination - before.destination
    );
    assert_eq!(ledger.entries[2].kind, TRADE_KIND_REFUSED);
    assert_eq!(ledger.entries[2].reason, REASON_OVER_DAILY);
    assert_eq!(ledger.entries[2].amount_out, 0);
}

/// A program-owned rule planted at the PDA its own fields derive, aimed at the
/// victim source and an agent-owned destination. On a cluster only the program
/// can write that account. The delegate on the victim source is the real rule.
#[test]
fn a_forged_rule_at_its_canonical_pda_cannot_spend_the_owner_source() {
    let mut w = open_world(Rules::default());
    let attacker = Keypair::new();
    let (forged, bump) = Pubkey::find_program_address(
        &[b"trade", attacker.pubkey().as_ref(), &77u64.to_le_bytes()],
        &veto::id(),
    );
    let real = w.svm.get_account(&w.rule).unwrap();
    let mut rule = read_rule(&w.svm, &w.rule);
    rule.owner = attacker.pubkey();
    rule.agent = w.agent.pubkey();
    rule.rule_id = 77;
    rule.bump = bump;
    rule.source = w.source;
    rule.destination = w.agent_out;
    rule.cap = 1_000 * IN_ONE;
    rule.per_trade_max = 1_000 * IN_ONE;
    rule.daily_limit = 1_000 * IN_ONE;
    rule.spent = 0;
    rule.window_spent = 0;
    rule.window_start = now(&w.svm);
    rule.floor_num = 1;
    rule.floor_den = 1;
    rule.expires_at = FAR_FUTURE;
    rule.status = STATUS_ACTIVE;
    rule.last_nonce = 0;
    rule.override_nonce = 0;
    rule.override_amount = 0;
    let mut data = Vec::new();
    rule.try_serialize(&mut data).unwrap();
    data.resize(real.data.len(), 0);
    plant(&mut w.svm, forged, real.lamports, data);

    let (forged_ledger, _) =
        Pubkey::find_program_address(&[b"trade-ledger", forged.as_ref()], &veto::id());
    let real_ledger = w.svm.get_account(&w.ledger).unwrap();
    let mut ledger_data = real_ledger.data.clone();
    ledger_data[8..40].copy_from_slice(forged.as_ref());
    plant(&mut w.svm, forged_ledger, real_ledger.lamports, ledger_data);

    let amount_in = 10 * IN_ONE;
    let before = snap(&w);
    let real_total = read_ledger(&w.svm, &w.ledger).total;
    let ix = TradeIx {
        rule: forged,
        ledger: forged_ledger,
        destination: w.agent_out,
        ..TradeIx::honest(&w)
    }
    .build(amount_in, 1, 1);
    submit(&mut w, ix).expect("forgery confirms as a refusal");
    assert_held(&w, &before, &[]);
    assert_eq!(read_ledger(&w.svm, &w.ledger).total, real_total);
    assert_eq!(read_rule(&w.svm, &w.rule).spent, 0);
    assert_eq!(read_rule(&w.svm, &w.rule).last_nonce, 0);
    let entry = last_entry(&w.svm, &forged_ledger);
    assert_eq!(entry.kind, TRADE_KIND_REFUSED);
    assert_eq!(entry.reason, REASON_DELEGATE_MISSING);
    assert_eq!(entry.amount_out, 0);
    assert_eq!(
        token_account(&w.svm, &w.source).delegate,
        COption::Some(w.rule)
    );
}
