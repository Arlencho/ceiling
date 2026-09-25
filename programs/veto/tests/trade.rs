//! Trade rule: one pool, a cap, a daily window, and a price floor.
//!
//! Same LiteSVM harness as `hold.rs`. The token-swap program is the ELF
//! loaded by `token_swap_fixture.rs`. Initialize uses that file's enforced
//! fee schedule (trade 25/10000 and owner trade 5/10000). The rejected
//! schedule is not used. Swap data is tag 1 plus two little-endian amounts,
//! and the program reads exactly ten accounts. A 14-account swap is the
//! later program's layout, and this one rejects it.
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
        AccountDeserialize, Discriminator, InstructionData, Space, ToAccountMetas,
    },
    anchor_spl::token::spl_token,
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    std::str::FromStr,
    veto::{
        trade::{OpenTradeRuleArgs, TradeRefused, Traded},
        HoldLedger, HoldVault, Ledger, Mandate, TradeEntry, TradeLedger, TradeRule,
        EXCHANGE_KIND_SPL_TOKEN_SWAP, REASON_ACCOUNT_FROZEN, REASON_BELOW_FLOOR,
        REASON_DELEGATE_MISSING, REASON_DESTINATION_NOT_ALLOWED, REASON_EXPIRED,
        REASON_INSUFFICIENT_FUNDS, REASON_NOT_ACTIVE, REASON_OVER_CAP, REASON_OVER_DAILY,
        REASON_OVER_PER_TX_MAX, REASON_POOL_NOT_ALLOWED, REASON_STALE_NONCE, REASON_ZERO_AMOUNT,
        STATUS_ACTIVE, STATUS_EXHAUSTED, STATUS_EXPIRED, TRADE_KIND_REFUSED, TRADE_KIND_TRADED,
        TRADE_LEDGER_CAPACITY, TRADE_WINDOW_SECS,
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

/// The schedule Veto supports. The exchange also accepts higher fees.
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
    pool: Pubkey,
    pool_authority: Pubkey,
    vault_in: Pubkey,
    vault_out: Pubkey,
    pool_mint: Pubkey,
    fee_account: Pubkey,
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
        Ok(_) => panic!("expected an error containing {needle:?}, transaction succeeded"),
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

fn decode_b64(input: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let bytes = input.as_bytes();
    if bytes.is_empty() || bytes.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        let (a, b, c, d) = (chunk[0], chunk[1], chunk[2], chunk[3]);
        let av = val(a)?;
        let bv = val(b)?;
        let cv = if c == b'=' { 0 } else { val(c)? };
        let dv = if d == b'=' { 0 } else { val(d)? };
        out.push((av << 2) | (bv >> 4));
        if c != b'=' {
            out.push((bv << 4) | (cv >> 2));
        }
        if d != b'=' {
            out.push((cv << 6) | dv);
        }
    }
    Some(out)
}

fn saw_event(logs: &[String], disc: &[u8]) -> bool {
    logs.iter().any(|line| {
        let Some(data) = line.strip_prefix("Program data: ") else {
            return false;
        };
        let Some(raw) = decode_b64(data.trim()) else {
            return false;
        };
        raw.len() >= disc.len() && raw[..disc.len()] == *disc
    })
}

fn snap(w: &World) -> Snap {
    let source = token_account(&w.svm, &w.source);
    Snap {
        source: source.amount,
        destination: token_amount(&w.svm, &w.destination),
        vault_in: token_amount(&w.svm, &w.vault_in),
        vault_out: token_amount(&w.svm, &w.vault_out),
        agent_in: token_amount(&w.svm, &w.agent_in),
        agent_out: token_amount(&w.svm, &w.agent_out),
        delegated: source.delegated_amount,
        agent_lamports: lamports(&w.svm, &w.agent.pubkey()),
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

fn rule_pdas(owner: &Pubkey, rule_id: u64) -> (Pubkey, Pubkey) {
    let (rule, _) = Pubkey::find_program_address(
        &[b"trade", owner.as_ref(), &rule_id.to_le_bytes()],
        &veto::id(),
    );
    let (ledger, _) = Pubkey::find_program_address(&[b"trade-ledger", rule.as_ref()], &veto::id());
    (rule, ledger)
}

fn open_world(rules: Rules) -> World {
    open_world_with_reserves(rules, LIQUIDITY_IN, LIQUIDITY_OUT)
}

fn open_world_with_reserves(rules: Rules, liquidity_in: u64, liquidity_out: u64) -> World {
    let (mut svm, owner, agent) = boot();
    let exchange_program = token_swap_id();
    let in_mint = create_mint(&mut svm, &owner, IN_DECIMALS, &owner.pubkey());
    let out_mint = create_mint(&mut svm, &owner, OUT_DECIMALS, &owner.pubkey());

    let swap_kp = Keypair::new();
    let pool = swap_kp.pubkey();
    let (pool_authority, bump) = Pubkey::find_program_address(&[pool.as_ref()], &exchange_program);
    let vault_in = create_token_account(&mut svm, &owner, &in_mint, &pool_authority);
    let vault_out = create_token_account(&mut svm, &owner, &out_mint, &pool_authority);
    mint_to(&mut svm, &owner, &in_mint, &vault_in, liquidity_in);
    mint_to(&mut svm, &owner, &out_mint, &vault_out, liquidity_out);

    let pool_mint_kp = Keypair::new();
    let pool_mint = pool_mint_kp.pubkey();
    send(
        &mut svm,
        &owner,
        &[&owner, &pool_mint_kp],
        &[
            system_instruction::create_account(
                &owner.pubkey(),
                &pool_mint,
                10_000_000,
                spl_token::state::Mint::LEN as u64,
                &spl_token::ID,
            ),
            spl_token::instruction::initialize_mint2(
                &spl_token::ID,
                &pool_mint,
                &pool_authority,
                None,
                IN_DECIMALS,
            )
            .unwrap(),
        ],
    )
    .expect("create pool mint");

    let fee_account = create_token_account(&mut svm, &owner, &pool_mint, &fee_owner());
    let lp_dest = create_token_account(&mut svm, &owner, &pool_mint, &owner.pubkey());
    let init = Instruction {
        program_id: exchange_program,
        accounts: vec![
            AccountMeta::new(pool, true),
            AccountMeta::new_readonly(pool_authority, false),
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
        &mut svm,
        &owner,
        &[&owner, &swap_kp],
        &[
            system_instruction::create_account(
                &owner.pubkey(),
                &pool,
                10_000_000,
                SWAP_ACCOUNT_LEN,
                &exchange_program,
            ),
            init,
        ],
    )
    .expect("initialize pool");

    let fee = token_account(&svm, &fee_account);
    assert_eq!(
        fee.owner,
        fee_owner(),
        "fee account owner is the fixture fee owner"
    );
    assert_eq!(fee.mint, pool_mint);

    let source = create_token_account(&mut svm, &owner, &in_mint, &owner.pubkey());
    let destination = create_token_account(&mut svm, &owner, &out_mint, &owner.pubkey());
    mint_to(&mut svm, &owner, &in_mint, &source, USER_FUNDS);
    let agent_in = create_token_account(&mut svm, &owner, &in_mint, &agent.pubkey());
    let agent_out = create_token_account(&mut svm, &owner, &out_mint, &agent.pubkey());
    mint_to(&mut svm, &owner, &in_mint, &agent_in, 1);
    mint_to(&mut svm, &owner, &out_mint, &agent_out, 1);

    let (rule, ledger) = rule_pdas(&owner.pubkey(), rules.rule_id);
    let open = Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::OpenTradeRule {
            args: OpenTradeRuleArgs {
                rule_id: rules.rule_id,
                agent: agent.pubkey(),
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
            owner: owner.pubkey(),
            rule,
            ledger,
            source,
            destination,
            in_mint,
            out_mint,
            exchange_program,
            pool,
            pool_authority,
            pool_in_vault: vault_in,
            pool_out_vault: vault_out,
            pool_mint,
            pool_fee_account: fee_account,
            token_program: spl_token::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(&mut svm, &owner, &[&owner], &[open]).expect("open trade rule");

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
        exchange_program,
        pool,
        pool_authority,
        vault_in,
        vault_out,
        pool_mint,
        fee_account,
        rule,
        ledger,
    }
}

fn trade_ix(
    w: &World,
    amount_in: u64,
    min_out: u64,
    nonce: u64,
    destination: Pubkey,
    pool: Pubkey,
) -> Instruction {
    Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::Trade {
            amount_in,
            min_out,
            nonce,
        }
        .data(),
        veto::accounts::Trade {
            agent: w.agent.pubkey(),
            rule: w.rule,
            ledger: w.ledger,
            source: w.source,
            destination,
            exchange_program: w.exchange_program,
            pool,
            pool_authority: w.pool_authority,
            pool_in_vault: w.vault_in,
            pool_out_vault: w.vault_out,
            pool_mint: w.pool_mint,
            pool_fee_account: w.fee_account,
            token_program: spl_token::ID,
        }
        .to_account_metas(None),
    )
}

fn submit(w: &mut World, ix: Instruction) -> Result<litesvm::types::TransactionMetadata, String> {
    let owner = w.owner.insecure_clone();
    let agent = w.agent.insecure_clone();
    send(&mut w.svm, &owner, &[&owner, &agent], &[ix])
}

fn trade(
    w: &mut World,
    amount_in: u64,
    min_out: u64,
    nonce: u64,
) -> Result<litesvm::types::TransactionMetadata, String> {
    let ix = trade_ix(w, amount_in, min_out, nonce, w.destination, w.pool);
    submit(w, ix)
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

fn close_rule(w: &mut World) -> Result<litesvm::types::TransactionMetadata, String> {
    let owner = w.owner.insecure_clone();
    let ix = Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::CloseTradeRule {}.data(),
        veto::accounts::CloseTradeRule {
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

fn assert_refused(w: &World, logs: &[String], before: &Snap, reason: u8, tried: Pubkey) {
    assert_unmoved(before, &snap(w));
    let entry = last_entry(&w.svm, &w.ledger);
    assert_eq!(entry.kind, TRADE_KIND_REFUSED, "ledger kind");
    assert_eq!(entry.reason, reason, "ledger reason");
    assert_eq!(entry.counterparty, tried, "tried account");
    assert_eq!(entry.amount_out, 0);
    let needle = format!("VETO TRADE REFUSED reason={reason}");
    assert!(
        logs.iter().any(|line| line.contains(&needle)),
        "missing refusal log {needle}\n{}",
        logs.join("\n")
    );
    assert!(
        saw_event(logs, TradeRefused::DISCRIMINATOR),
        "missing TradeRefused event\n{}",
        logs.join("\n")
    );
}

#[test]
fn a_paid_trade_debits_the_source_by_the_input_and_credits_the_destination() {
    let mut w = open_world(Rules::default());
    let before = snap(&w);
    let amount_in = 10 * IN_ONE;
    let min_out = 1u64;
    let meta = trade(&mut w, amount_in, min_out, 1).expect("paid trade");
    let after = snap(&w);

    assert_eq!(before.source - after.source, amount_in);
    let gained = after.destination - before.destination;
    assert!(gained >= min_out, "destination gained {gained}");
    assert_eq!(before.delegated - after.delegated, amount_in);
    assert_eq!(after.vault_in, before.vault_in + amount_in);
    assert_eq!(before.vault_out - after.vault_out, gained);
    assert_eq!(after.agent_in, before.agent_in);
    assert_eq!(after.agent_out, before.agent_out);
    assert_eq!(after.agent_lamports, before.agent_lamports);

    let entry = last_entry(&w.svm, &w.ledger);
    assert_eq!(entry.kind, TRADE_KIND_TRADED);
    assert_eq!(entry.amount_in, before.source - after.source);
    assert_eq!(entry.amount_out, gained);
    assert_eq!(entry.counterparty, w.pool);

    let rule = read_rule(&w.svm, &w.rule);
    assert_eq!(rule.spent, amount_in);
    assert_eq!(rule.trade_count, 1);
    assert_eq!(rule.last_nonce, 1);
    assert_eq!(rule.status, STATUS_ACTIVE);
    assert_eq!(rule.refusal_count, 0);

    let line = format!(
        "Program log: VETO TRADED amount_in={amount_in} amount_out={gained} spent={amount_in} of cap={} remaining_today={}",
        rule.cap,
        rule.daily_limit - amount_in
    );
    assert!(
        meta.logs.iter().any(|row| row == &line),
        "missing traded log {line}\n{}",
        meta.logs.join("\n")
    );
    assert!(saw_event(&meta.logs, Traded::DISCRIMINATOR));
}

#[test]
fn a_trade_on_a_rule_that_is_not_active_is_refused_with_reason_1() {
    let mut w = open_world(Rules {
        cap: 10 * IN_ONE,
        per_trade_max: 10 * IN_ONE,
        daily_limit: 10 * IN_ONE,
        ..Rules::default()
    });
    trade(&mut w, 10 * IN_ONE, 1, 1).expect("trade that exhausts the cap");
    assert_eq!(read_rule(&w.svm, &w.rule).status, STATUS_EXHAUSTED);

    let before = snap(&w);
    let meta = trade(&mut w, 10 * IN_ONE, 1, 2).expect("refusal confirms");
    assert_refused(&w, &meta.logs, &before, REASON_NOT_ACTIVE, w.pool);
}

#[test]
fn a_trade_at_or_after_expiry_is_refused_with_reason_2_and_the_rule_expires() {
    let opened_at = now(&open_world(Rules::default()).svm);
    let mut w = open_world(Rules {
        expires_at: opened_at + 60,
        ..Rules::default()
    });
    warp(&mut w.svm, opened_at + 60);
    let before = snap(&w);
    let meta = trade(&mut w, 10 * IN_ONE, 1, 1).expect("refusal confirms");
    assert_refused(&w, &meta.logs, &before, REASON_EXPIRED, w.pool);
    assert_eq!(read_rule(&w.svm, &w.rule).status, STATUS_EXPIRED);
}

#[test]
fn a_replayed_nonce_is_refused_with_reason_3_and_moves_nothing() {
    let mut w = open_world(Rules::default());
    trade(&mut w, 10 * IN_ONE, 1, 4).expect("first trade pays");
    let before = snap(&w);
    let meta = trade(&mut w, 10 * IN_ONE, 1, 4).expect("replay confirms");
    assert_refused(&w, &meta.logs, &before, REASON_STALE_NONCE, w.pool);
    assert_eq!(read_rule(&w.svm, &w.rule).last_nonce, 4);
}

#[test]
fn a_trade_over_the_per_trade_maximum_is_refused_with_reason_5_and_names_an_override() {
    let mut w = open_world(Rules::default());
    let before = snap(&w);
    let amount = 30 * IN_ONE;
    let meta = trade(&mut w, amount, 1, 1).expect("refusal confirms");
    assert_refused(&w, &meta.logs, &before, REASON_OVER_PER_TX_MAX, w.pool);
    let entry = last_entry(&w.svm, &w.ledger);
    assert_eq!(entry.suggested_override, amount);
    let expected = "Program log: VETO TRADE REFUSED reason=5 (over per-trade maximum) amount_in=30000000 per_trade_max=20000000 remaining=100000000 remaining_today=50000000 override_to_clear=30000000";
    assert!(
        meta.logs.iter().any(|row| row == expected),
        "missing exact refusal log\n{}",
        meta.logs.join("\n")
    );

    let over_day = 80 * IN_ONE;
    let before = snap(&w);
    let meta = trade(&mut w, over_day, 1, 2).expect("second refusal confirms");
    assert_refused(&w, &meta.logs, &before, REASON_OVER_PER_TX_MAX, w.pool);
    assert_eq!(last_entry(&w.svm, &w.ledger).suggested_override, 0);
    let expected = "Program log: VETO TRADE REFUSED reason=5 (over per-trade maximum) amount_in=80000000 per_trade_max=20000000 remaining=100000000 remaining_today=50000000 override_to_clear=0";
    assert!(
        meta.logs.iter().any(|row| row == expected),
        "missing exact refusal log\n{}",
        meta.logs.join("\n")
    );
}

#[test]
fn a_trade_over_the_remaining_cap_is_refused_with_reason_6() {
    let mut w = open_world(Rules {
        per_trade_max: 40 * IN_ONE,
        daily_limit: 40 * IN_ONE,
        cap: 60 * IN_ONE,
        ..Rules::default()
    });
    trade(&mut w, 40 * IN_ONE, 1, 1).expect("first trade pays");
    let window_start = now(&w.svm);
    warp(&mut w.svm, window_start + TRADE_WINDOW_SECS + 3600);
    let before = snap(&w);
    let meta = trade(&mut w, 40 * IN_ONE, 1, 2).expect("refusal confirms");
    assert_refused(&w, &meta.logs, &before, REASON_OVER_CAP, w.pool);
}

#[test]
fn a_trade_without_the_rule_as_delegate_is_refused_with_reason_7() {
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

    let before = snap(&w);
    let meta = trade(&mut w, 10 * IN_ONE, 1, 1).expect("refusal confirms");
    assert_refused(&w, &meta.logs, &before, REASON_DELEGATE_MISSING, w.pool);
}

#[test]
fn a_trade_the_source_cannot_cover_is_refused_with_reason_8() {
    let mut w = open_world(Rules::default());
    let owner = w.owner.insecure_clone();
    let park = create_token_account(&mut w.svm, &owner, &w.in_mint, &owner.pubkey());
    let have = token_amount(&w.svm, &w.source);
    send(
        &mut w.svm,
        &owner,
        &[&owner],
        &[spl_token::instruction::transfer(
            &spl_token::ID,
            &w.source,
            &park,
            &owner.pubkey(),
            &[],
            have - 1,
        )
        .unwrap()],
    )
    .expect("owner moves almost all of the input aside");

    let before = snap(&w);
    let meta = trade(&mut w, 10 * IN_ONE, 1, 1).expect("refusal confirms");
    assert_refused(&w, &meta.logs, &before, REASON_INSUFFICIENT_FUNDS, w.pool);
    assert_eq!(token_amount(&w.svm, &park), have - 1);
}

#[test]
fn a_zero_trade_is_refused_with_reason_9() {
    let mut w = open_world(Rules::default());
    let before = snap(&w);
    let meta = trade(&mut w, 0, 0, 1).expect("refusal confirms");
    assert_refused(&w, &meta.logs, &before, REASON_ZERO_AMOUNT, w.pool);
}

#[test]
fn a_trade_against_a_frozen_account_is_refused_with_reason_10() {
    let mut w = open_world(Rules::default());
    let owner = w.owner.insecure_clone();
    send(
        &mut w.svm,
        &owner,
        &[&owner],
        &[spl_token::instruction::freeze_account(
            &spl_token::ID,
            &w.source,
            &w.in_mint,
            &owner.pubkey(),
            &[],
        )
        .unwrap()],
    )
    .expect("freeze the source");
    assert!(token_account(&w.svm, &w.source).is_frozen());

    let before = snap(&w);
    let meta = trade(&mut w, 10 * IN_ONE, 1, 1).expect("refusal confirms");
    assert_refused(&w, &meta.logs, &before, REASON_ACCOUNT_FROZEN, w.pool);
}

#[test]
fn a_trade_to_a_different_destination_is_refused_with_reason_11_and_names_that_account() {
    let mut w = open_world(Rules::default());
    let owner = w.owner.insecure_clone();
    let other = create_token_account(&mut w.svm, &owner, &w.out_mint, &owner.pubkey());
    let before = snap(&w);
    let other_before = token_amount(&w.svm, &other);
    let ix = trade_ix(&w, 10 * IN_ONE, 1, 1, other, w.pool);
    let meta = submit(&mut w, ix).expect("refusal confirms");
    assert_refused(
        &w,
        &meta.logs,
        &before,
        REASON_DESTINATION_NOT_ALLOWED,
        other,
    );
    assert_eq!(token_amount(&w.svm, &other), other_before);
}

#[test]
fn a_trade_against_a_different_pool_is_refused_with_reason_12_and_names_that_account() {
    let mut w = open_world(Rules::default());
    let fake = Keypair::new();
    w.svm.airdrop(&fake.pubkey(), 1_000_000).unwrap();
    let before = snap(&w);
    let ix = trade_ix(&w, 10 * IN_ONE, 1, 1, w.destination, fake.pubkey());
    let meta = submit(&mut w, ix).expect("refusal confirms");
    assert_refused(
        &w,
        &meta.logs,
        &before,
        REASON_POOL_NOT_ALLOWED,
        fake.pubkey(),
    );
}

#[test]
fn a_trade_over_the_daily_limit_is_refused_with_reason_13() {
    let mut w = open_world(Rules {
        per_trade_max: 30 * IN_ONE,
        daily_limit: 50 * IN_ONE,
        cap: 200 * IN_ONE,
        ..Rules::default()
    });
    trade(&mut w, 30 * IN_ONE, 1, 1).expect("first trade pays");
    let before = snap(&w);
    let meta = trade(&mut w, 30 * IN_ONE, 1, 2).expect("refusal confirms");
    assert_refused(&w, &meta.logs, &before, REASON_OVER_DAILY, w.pool);
}

#[test]
fn a_trade_below_the_price_floor_is_refused_with_reason_14() {
    let mut w = open_world(Rules {
        floor_num: 1000,
        floor_den: 1,
        ..Rules::default()
    });
    let before = snap(&w);
    let meta = trade(&mut w, 10 * IN_ONE, 1, 1).expect("refusal confirms");
    assert_refused(&w, &meta.logs, &before, REASON_BELOW_FLOOR, w.pool);
}

#[test]
fn an_override_lets_one_nonce_past_the_per_trade_maximum_and_does_not_lift_the_daily_limit_or_the_cap(
) {
    let mut w = open_world(Rules {
        per_trade_max: 10 * IN_ONE,
        daily_limit: 50 * IN_ONE,
        cap: 70 * IN_ONE,
        ..Rules::default()
    });
    grant(&mut w, 60 * IN_ONE, 10).expect("override granted");

    let before = snap(&w);
    let over_day = trade(&mut w, 60 * IN_ONE, 1, 10).expect("daily refusal confirms");
    assert_refused(&w, &over_day.logs, &before, REASON_OVER_DAILY, w.pool);
    assert_eq!(read_rule(&w.svm, &w.rule).override_nonce, 10);

    trade(&mut w, 10 * IN_ONE, 1, 1).expect("pays");
    trade(&mut w, 10 * IN_ONE, 1, 2).expect("pays");
    trade(&mut w, 10 * IN_ONE, 1, 3).expect("pays");
    assert_eq!(read_rule(&w.svm, &w.rule).spent, 30 * IN_ONE);

    let window_start = now(&w.svm);
    warp(&mut w.svm, window_start + TRADE_WINDOW_SECS + 3600);

    let before = snap(&w);
    let over_cap = trade(&mut w, 45 * IN_ONE, 1, 10).expect("cap refusal confirms");
    assert_refused(&w, &over_cap.logs, &before, REASON_OVER_CAP, w.pool);
    assert_eq!(read_rule(&w.svm, &w.rule).override_nonce, 10);

    let before = snap(&w);
    let meta = trade(&mut w, 20 * IN_ONE, 1, 10).expect("override trade pays");
    let after = snap(&w);
    assert_eq!(before.source - after.source, 20 * IN_ONE);
    assert!(after.destination - before.destination >= 1);
    assert_eq!(before.delegated - after.delegated, 20 * IN_ONE);
    assert_eq!(after.agent_in, before.agent_in);
    assert_eq!(after.agent_out, before.agent_out);
    let rule = read_rule(&w.svm, &w.rule);
    assert_eq!(rule.spent, 50 * IN_ONE);
    assert_eq!(rule.last_nonce, 10);
    assert_eq!(rule.override_nonce, 0);
    assert_eq!(rule.override_amount, 0);
    assert_eq!(last_entry(&w.svm, &w.ledger).kind, TRADE_KIND_TRADED);
    assert!(saw_event(&meta.logs, Traded::DISCRIMINATOR));
}

#[test]
fn revoke_trade_rule_clears_the_delegate_and_a_later_trade_is_refused_with_reason_1() {
    let mut w = open_world(Rules::default());
    revoke(&mut w).expect("revoke");
    assert_eq!(token_account(&w.svm, &w.source).delegate, COption::None);
    assert_eq!(read_rule(&w.svm, &w.rule).status, veto::STATUS_REVOKED);

    let before = snap(&w);
    let meta = trade(&mut w, 10 * IN_ONE, 1, 1).expect("refusal confirms");
    assert_refused(&w, &meta.logs, &before, REASON_NOT_ACTIVE, w.pool);
    assert_eq!(token_account(&w.svm, &w.source).delegate, COption::None);
}

#[test]
fn revoke_on_a_frozen_source_flips_the_status_and_a_trade_after_thaw_is_refused_with_reason_1() {
    let mut w = open_world(Rules::default());
    let owner = w.owner.insecure_clone();
    send(
        &mut w.svm,
        &owner,
        &[&owner],
        &[spl_token::instruction::freeze_account(
            &spl_token::ID,
            &w.source,
            &w.in_mint,
            &owner.pubkey(),
            &[],
        )
        .unwrap()],
    )
    .expect("freeze the source");

    revoke(&mut w).expect("revoke on a frozen source");
    assert_eq!(read_rule(&w.svm, &w.rule).status, veto::STATUS_REVOKED);
    assert_eq!(
        token_account(&w.svm, &w.source).delegate,
        COption::Some(w.rule)
    );

    send(
        &mut w.svm,
        &owner,
        &[&owner],
        &[spl_token::instruction::thaw_account(
            &spl_token::ID,
            &w.source,
            &w.in_mint,
            &owner.pubkey(),
            &[],
        )
        .unwrap()],
    )
    .expect("thaw the source");

    let before = snap(&w);
    let meta = trade(&mut w, 10 * IN_ONE, 1, 1).expect("refusal confirms");
    assert_refused(&w, &meta.logs, &before, REASON_NOT_ACTIVE, w.pool);
}

#[test]
fn close_trade_rule_is_refused_while_the_rule_is_active_and_returns_rent_after_revoke() {
    let mut w = open_world(Rules::default());
    assert_err(close_rule(&mut w), "TradeRuleStillActive");
    assert!(lamports(&w.svm, &w.rule) > 0);
    assert!(read_rule(&w.svm, &w.rule).status == STATUS_ACTIVE);

    revoke(&mut w).expect("revoke");
    let owner = w.owner.pubkey();
    let rule_rent = lamports(&w.svm, &w.rule);
    let ledger_rent = lamports(&w.svm, &w.ledger);
    let before = lamports(&w.svm, &owner);
    let meta = close_rule(&mut w).expect("close after revoke");
    let after = lamports(&w.svm, &owner);
    assert_eq!(after + meta.fee, before + rule_rent + ledger_rent);
    assert_eq!(lamports(&w.svm, &w.rule), 0);
    assert_eq!(lamports(&w.svm, &w.ledger), 0);
}

#[test]
fn a_mandate_account_passed_as_a_trade_rule_fails_the_discriminator_check() {
    let mut w = open_world(Rules::default());
    let owner = w.owner.insecure_clone();
    let mint = create_mint(&mut w.svm, &owner, IN_DECIMALS, &owner.pubkey());
    let source = create_token_account(&mut w.svm, &owner, &mint, &owner.pubkey());
    let (mandate, mandate_ledger) = {
        let (mandate, _) = Pubkey::find_program_address(
            &[b"mandate", owner.pubkey().as_ref(), &1u64.to_le_bytes()],
            &veto::id(),
        );
        let (ledger, _) = Pubkey::find_program_address(&[b"ledger", mandate.as_ref()], &veto::id());
        (mandate, ledger)
    };
    let open = Instruction::new_with_bytes(
        veto::id(),
        &veto::instruction::OpenMandate {
            args: veto::OpenMandateArgs {
                mandate_id: 1,
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
            source,
            mint,
            token_program: spl_token::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    send(&mut w.svm, &owner, &[&owner], &[open]).expect("open mandate");

    let mut ix = trade_ix(&w, 10 * IN_ONE, 1, 1, w.destination, w.pool);
    assert_eq!(ix.accounts[1].pubkey, w.rule);
    ix.accounts[1].pubkey = mandate;
    let before = snap(&w);
    assert_err(submit(&mut w, ix), "AccountDiscriminatorMismatch");
    assert_unmoved(&before, &snap(&w));
}

#[test]
fn an_extra_account_on_trade_is_an_error_and_moves_nothing() {
    let mut w = open_world(Rules::default());
    let mut ix = trade_ix(&w, 10 * IN_ONE, 1, 1, w.destination, w.pool);
    ix.accounts
        .push(AccountMeta::new_readonly(w.agent_in, false));
    let before = snap(&w);
    assert_err(submit(&mut w, ix), "UnexpectedTradeAccount");
    assert_unmoved(&before, &snap(&w));
}

/// Empty the owner's token account into a fresh one and close it.
fn close_owner_account(w: &mut World, account: Pubkey, mint: Pubkey) {
    let owner = w.owner.insecure_clone();
    let balance = token_amount(&w.svm, &account);
    let mut ixs = Vec::new();
    if balance > 0 {
        let sink = create_token_account(&mut w.svm, &owner, &mint, &owner.pubkey());
        ixs.push(
            spl_token::instruction::transfer(
                &spl_token::ID,
                &account,
                &sink,
                &owner.pubkey(),
                &[],
                balance,
            )
            .unwrap(),
        );
    }
    ixs.push(
        spl_token::instruction::close_account(
            &spl_token::ID,
            &account,
            &owner.pubkey(),
            &owner.pubkey(),
            &[],
        )
        .unwrap(),
    );
    send(&mut w.svm, &owner, &[&owner], &ixs).expect("owner closes the token account");
    assert!(w
        .svm
        .get_account(&account)
        .map_or(true, |a| a.lamports == 0));
}

#[test]
fn close_after_expiry_reclaims_rent_when_the_owner_closed_the_source() {
    let expires_at = 1_800_000_000;
    let mut w = open_world(Rules {
        expires_at,
        ..Rules::default()
    });
    assert!(now(&w.svm) < expires_at);
    let source = w.source;
    let in_mint = w.in_mint;
    close_owner_account(&mut w, source, in_mint);

    // The source is gone, so revoke cannot run and the rule stays active.
    assert_err(revoke(&mut w), "AccountNotInitialized");
    assert_eq!(read_rule(&w.svm, &w.rule).status, STATUS_ACTIVE);
    assert_err(close_rule(&mut w), "TradeRuleStillActive");

    warp(&mut w.svm, expires_at);
    let owner = w.owner.pubkey();
    let rule_rent = lamports(&w.svm, &w.rule);
    let ledger_rent = lamports(&w.svm, &w.ledger);
    let before = lamports(&w.svm, &owner);
    let meta = close_rule(&mut w).expect("close at expiry with the source closed");
    assert_eq!(
        lamports(&w.svm, &owner) + meta.fee,
        before + rule_rent + ledger_rent
    );
    assert_eq!(lamports(&w.svm, &w.rule), 0);
    assert_eq!(lamports(&w.svm, &w.ledger), 0);
}

#[test]
fn close_after_expiry_revokes_the_delegation_the_rule_still_holds() {
    let expires_at = 1_800_000_000;
    let mut w = open_world(Rules {
        expires_at,
        ..Rules::default()
    });
    trade(&mut w, 10 * IN_ONE, 1, 1).expect("paid trade");
    let open = token_account(&w.svm, &w.source);
    assert_eq!(open.delegate, COption::Some(w.rule));
    assert!(open.delegated_amount > 0);

    // Expired by a refused trade, then closed without a revoke.
    warp(&mut w.svm, expires_at);
    trade(&mut w, 10 * IN_ONE, 1, 2).expect("refusal confirms");
    assert_eq!(read_rule(&w.svm, &w.rule).status, STATUS_EXPIRED);
    assert_eq!(
        token_account(&w.svm, &w.source).delegate,
        COption::Some(w.rule)
    );
    let balance = token_amount(&w.svm, &w.source);

    let meta = close_rule(&mut w).expect("close after expiry");
    assert!(meta
        .logs
        .iter()
        .any(|l| l.contains("VETO TRADE CLOSED revoked=true")));
    let after = token_account(&w.svm, &w.source);
    assert_eq!(after.delegate, COption::None);
    assert_eq!(after.delegated_amount, 0);
    assert_eq!(after.amount, balance);
    assert_eq!(lamports(&w.svm, &w.rule), 0);

    // A second world: close at expiry while the status is still active.
    let mut w = open_world(Rules {
        expires_at,
        ..Rules::default()
    });
    warp(&mut w.svm, expires_at);
    assert_eq!(read_rule(&w.svm, &w.rule).status, STATUS_ACTIVE);
    close_rule(&mut w).expect("close at expiry while still marked active");
    assert_eq!(token_account(&w.svm, &w.source).delegate, COption::None);
}

#[test]
fn a_trade_into_a_destination_the_owner_closed_is_not_a_token_account() {
    let mut w = open_world(Rules::default());
    let destination = w.destination;
    let out_mint = w.out_mint;
    close_owner_account(&mut w, destination, out_mint);
    let delegated = token_account(&w.svm, &w.source).delegated_amount;
    let source = token_amount(&w.svm, &w.source);
    let total = read_ledger(&w.svm, &w.ledger).total;
    assert_err(trade(&mut w, 10 * IN_ONE, 1, 1), "NotATokenAccount");
    assert_eq!(token_amount(&w.svm, &w.source), source);
    assert_eq!(token_account(&w.svm, &w.source).delegated_amount, delegated);
    assert_eq!(read_ledger(&w.svm, &w.ledger).total, total);
}

#[test]
fn existing_mandate_and_hold_layouts_match_the_values_shipped_today() {
    assert_eq!(Mandate::INIT_SPACE, 302);
    assert_eq!(std::mem::size_of::<Ledger>(), 2344);
    assert_eq!(HoldVault::INIT_SPACE, 1283);
    assert_eq!(std::mem::size_of::<HoldLedger>(), 2088);
    assert_eq!(Mandate::DISCRIMINATOR, [113, 216, 98, 159, 185, 63, 55, 18]);
    assert_eq!(Ledger::DISCRIMINATOR, [43, 41, 21, 213, 180, 176, 95, 32]);
    assert_eq!(
        HoldVault::DISCRIMINATOR,
        [225, 219, 122, 198, 245, 163, 91, 55]
    );
    assert_eq!(
        HoldLedger::DISCRIMINATOR,
        [195, 103, 143, 50, 70, 255, 84, 161]
    );
    assert_eq!(TradeRule::INIT_SPACE, 983);
    assert_eq!(std::mem::size_of::<TradeEntry>(), 88);
    assert_eq!(std::mem::size_of::<TradeLedger>(), 2856);
}

#[test]
fn a_small_fee_trade_with_the_floor_at_the_program_quote_settles_for_exactly_the_quote() {
    for amount in [1999u64, 399] {
        let net = u128::from(veto::trade::input_after_fees(amount));
        let quote = (net * u128::from(LIQUIDITY_OUT) / (u128::from(LIQUIDITY_IN) + net)) as u64;
        let mut w = open_world(Rules {
            floor_num: quote,
            floor_den: amount,
            ..Rules::default()
        });
        trade(&mut w, amount, 0, 1).expect("small fee trade at the floor quote settles");
        let entry = last_entry(&w.svm, &w.ledger);
        assert_eq!(entry.kind, TRADE_KIND_TRADED);
        assert_eq!(entry.amount_out, quote);
    }
    assert_eq!(veto::trade::input_after_fees(0), 0);
    assert_eq!(veto::trade::input_after_fees(1), 0);
    assert_eq!(veto::trade::input_after_fees(399), 397);
    assert_eq!(veto::trade::input_after_fees(1999), 1994);
}

#[test]
fn close_after_expiry_with_a_frozen_delegate_returns_both_rents() {
    let mut w = open_world(Rules::default());
    let owner = w.owner.insecure_clone();
    send(
        &mut w.svm,
        &owner,
        &[&owner],
        &[spl_token::instruction::freeze_account(
            &spl_token::ID,
            &w.source,
            &w.in_mint,
            &owner.pubkey(),
            &[],
        )
        .unwrap()],
    )
    .expect("freeze delegated source");
    assert_eq!(
        token_account(&w.svm, &w.source).delegate,
        COption::Some(w.rule)
    );
    warp(&mut w.svm, FAR_FUTURE);
    let rents = lamports(&w.svm, &w.rule) + lamports(&w.svm, &w.ledger);
    let before = lamports(&w.svm, &owner.pubkey());
    let meta = close_rule(&mut w).expect("close frozen source at expiry");
    assert_eq!(lamports(&w.svm, &owner.pubkey()) + meta.fee, before + rents);
    assert_eq!(lamports(&w.svm, &w.rule), 0);
    assert_eq!(lamports(&w.svm, &w.ledger), 0);
    assert!(token_account(&w.svm, &w.source).is_frozen());
}

#[test]
fn unequal_reserves_settle_and_charge_observed_input_to_ledger_caps_window_and_event() {
    let amount = 10 * IN_ONE;
    let mut w = open_world_with_reserves(
        Rules {
            floor_num: 1,
            floor_den: 2000,
            cap: amount,
            daily_limit: amount,
            per_trade_max: amount,
            ..Rules::default()
        },
        1_000_000_000_000_000,
        1_000_000_000_000,
    );
    let before = snap(&w);
    let meta = trade(&mut w, amount, 1, 1).expect("unequal reserves settle");
    let after = snap(&w);
    let observed = before.source - after.source;
    assert!(observed > 0 && observed < amount);
    assert_eq!(after.vault_in - before.vault_in, observed);
    assert_eq!(before.delegated - after.delegated, observed);
    let entry = last_entry(&w.svm, &w.ledger);
    assert_eq!(entry.kind, TRADE_KIND_TRADED);
    assert_eq!(entry.amount_in, observed);
    assert_eq!(entry.amount_out, after.destination - before.destination);
    assert!(entry.amount_out >= amount / 2000);
    let rule = read_rule(&w.svm, &w.rule);
    assert_eq!(rule.spent, observed);
    assert_eq!(
        veto::trade::current_window_spent(&rule, now(&w.svm)).unwrap(),
        observed
    );
    assert_eq!(rule.remaining(), amount - observed);
    assert_eq!(rule.status, STATUS_ACTIVE);
    let line = format!("Program log: VETO TRADED amount_in={observed} amount_out={} spent={observed} of cap={amount} remaining_today={}", entry.amount_out, amount - observed);
    assert!(meta.logs.contains(&line));
    let event = meta
        .logs
        .iter()
        .filter_map(|line| decode_b64(line.strip_prefix("Program data: ")?))
        .find(|raw| raw.starts_with(Traded::DISCRIMINATOR))
        .expect("traded event");
    assert_eq!(
        u64::from_le_bytes(event[40..48].try_into().unwrap()),
        observed
    );
    assert_eq!(
        u64::from_le_bytes(event[64..72].try_into().unwrap()),
        observed
    );
}
