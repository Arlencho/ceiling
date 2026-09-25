//! Trade rule: a permission to swap, and a legible record when it is declined.
//!
//! The owner pins one input account, one output account, and one pool. The
//! agent may sell the input through that pool and can do nothing else. A trade
//! that breaks a rule confirms, moves nothing, and writes a refusal. Returning
//! an error would roll the ledger write back with it.
//!
//! The swap is the SPL token-swap v2 layout: ten accounts, no mint accounts,
//! and no host fee account. An eleventh account would be read as a host fee,
//! so `trade` rejects any extra account before it evaluates the rule.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_spl::token::{self, spl_token, TokenAccount};

use crate::trade_state::*;
use crate::VetoError;
use crate::{
    CloseTradeRule, GrantTradeOverride, OpenTradeRule, RevokeTradeRule, Trade, PURPOSE_MAX_LEN,
    REASON_ACCOUNT_FROZEN, REASON_DELEGATE_MISSING, REASON_EXPIRED, REASON_INSUFFICIENT_FUNDS,
    REASON_NOT_ACTIVE, REASON_OK, REASON_OVER_CAP, REASON_OVER_PER_TX_MAX, REASON_STALE_NONCE,
    REASON_ZERO_AMOUNT, STATUS_ACTIVE, STATUS_EXHAUSTED, STATUS_EXPIRED, STATUS_REVOKED,
};

pub fn open_trade_rule(ctx: Context<OpenTradeRule>, args: OpenTradeRuleArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(args.cap > 0, VetoError::CapMustBePositive);
    require!(args.daily_limit > 0, VetoError::DailyLimitRequired);
    require!(
        args.per_trade_max <= args.daily_limit && args.daily_limit <= args.cap,
        VetoError::TradeLimitsOutOfOrder
    );
    // The floor is the only bound on value extraction. The agent composes the
    // transaction and can move the pool around the owner's trade, so a zero
    // floor would let it take nearly all of the trade's value.
    require!(args.floor_num > 0, VetoError::FloorRequired);
    require!(args.floor_den > 0, VetoError::FloorDenominatorRequired);
    require!(args.expires_at > now, VetoError::ExpiryInThePast);
    require!(
        args.purpose.chars().count() <= PURPOSE_MAX_LEN,
        VetoError::PurposeTooLong
    );
    require_keys_neq!(
        args.agent,
        ctx.accounts.owner.key(),
        VetoError::AgentMustNotBeOwner
    );
    require!(
        args.exchange_kind == EXCHANGE_KIND_SPL_TOKEN_SWAP,
        VetoError::ExchangeNotSupported
    );
    require_keys_eq!(
        ctx.accounts.exchange_program.key(),
        SPL_TOKEN_SWAP_ID,
        VetoError::ExchangeNotSupported
    );

    let owner = ctx.accounts.owner.key();
    require_keys_eq!(
        ctx.accounts.source.owner,
        owner,
        VetoError::SourceNotOwnedByOwner
    );
    require_keys_eq!(
        ctx.accounts.source.mint,
        ctx.accounts.in_mint.key(),
        VetoError::MintMismatch
    );
    require_keys_eq!(
        ctx.accounts.destination.owner,
        owner,
        VetoError::DestinationNotOwnedByOwner
    );
    require_keys_eq!(
        ctx.accounts.destination.mint,
        ctx.accounts.out_mint.key(),
        VetoError::MintMismatch
    );

    require_pool_shape(&ctx)?;

    let rule_key = ctx.accounts.rule.key();
    // Approving a new delegate replaces the old one. Opening over another
    // delegation would silently disable whatever set it.
    if let COption::Some(existing) = ctx.accounts.source.delegate {
        require_keys_eq!(existing, rule_key, VetoError::SourceAlreadyDelegated);
    }
    let pool = ctx.accounts.pool.key();
    let bump = ctx.bumps.rule;
    let ledger_bump = ctx.bumps.ledger;

    {
        let rule = &mut ctx.accounts.rule;
        rule.owner = owner;
        rule.agent = args.agent;
        rule.source = ctx.accounts.source.key();
        rule.destination = ctx.accounts.destination.key();
        rule.in_mint = ctx.accounts.in_mint.key();
        rule.out_mint = ctx.accounts.out_mint.key();
        rule.exchange_program = ctx.accounts.exchange_program.key();
        rule.exchange_kind = args.exchange_kind;
        rule.pool = pool;
        rule.pool_authority = ctx.accounts.pool_authority.key();
        rule.pool_in_vault = ctx.accounts.pool_in_vault.key();
        rule.pool_out_vault = ctx.accounts.pool_out_vault.key();
        rule.pool_mint = ctx.accounts.pool_mint.key();
        rule.pool_fee_account = ctx.accounts.pool_fee_account.key();
        rule.rule_id = args.rule_id;
        rule.cap = args.cap;
        rule.spent = 0;
        rule.per_trade_max = args.per_trade_max;
        rule.daily_limit = args.daily_limit;
        rule.daily_buckets = [TradeBucket::default(); TRADE_BUCKET_COUNT];
        rule.floor_num = args.floor_num;
        rule.floor_den = args.floor_den;
        rule.expires_at = args.expires_at;
        rule.override_amount = 0;
        rule.override_nonce = 0;
        rule.last_nonce = 0;
        rule.purpose = args.purpose;
        rule.status = STATUS_ACTIVE;
        rule.trade_count = 0;
        rule.refusal_count = 0;
        rule.bump = bump;
    }

    let ledger = &mut ctx.accounts.ledger.load_init()?;
    ledger.rule = rule_key;
    ledger.head = 0;
    ledger.total = 0;
    ledger.bump = ledger_bump;
    ledger.record(TradeEntry {
        ts: now,
        amount_in: args.cap,
        amount_out: 0,
        min_out: 0,
        counterparty: pool,
        nonce: 0,
        suggested_override: 0,
        kind: TRADE_KIND_OPENED,
        reason: REASON_OK,
        _pad: [0; 6],
    });

    token::approve_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            token::ApproveChecked {
                to: ctx.accounts.source.to_account_info(),
                mint: ctx.accounts.in_mint.to_account_info(),
                delegate: ctx.accounts.rule.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        args.cap,
        ctx.accounts.in_mint.decimals,
    )?;

    msg!(
        "VETO TRADE OPENED cap={} per_trade_max={} daily_limit={} expires_at={}",
        args.cap,
        args.per_trade_max,
        args.daily_limit,
        args.expires_at
    );
    Ok(())
}

pub fn trade(ctx: Context<Trade>, amount_in: u64, min_out: u64, nonce: u64) -> Result<()> {
    // The token-swap program treats an 11th account as a host fee account.
    // The agent must not be able to name one.
    require!(
        ctx.remaining_accounts.is_empty(),
        VetoError::UnexpectedTradeAccount
    );

    let now = Clock::get()?.unix_timestamp;
    let rule_key = ctx.accounts.rule.key();
    let owner = ctx.accounts.rule.owner;
    let rule_id_bytes = ctx.accounts.rule.rule_id.to_le_bytes();
    let bump = ctx.accounts.rule.bump;
    let expected = Pubkey::create_program_address(
        &[b"trade", owner.as_ref(), &rule_id_bytes, &[bump]],
        &crate::ID,
    )
    .map_err(|_| error!(VetoError::InvalidTradeRulePda))?;
    require_keys_eq!(expected, rule_key, VetoError::InvalidTradeRulePda);

    let verdict = evaluate(
        &ctx.accounts.rule,
        rule_key,
        &ctx.accounts.source,
        &ctx.accounts.destination.to_account_info(),
        &ctx.accounts.pool.to_account_info(),
        &ctx.accounts.pool_authority.to_account_info(),
        &ctx.accounts.pool_in_vault.to_account_info(),
        &ctx.accounts.pool_out_vault.to_account_info(),
        &ctx.accounts.pool_mint.to_account_info(),
        &ctx.accounts.pool_fee_account.to_account_info(),
        &ctx.accounts.exchange_program.to_account_info(),
        amount_in,
        nonce,
        now,
    )?;

    if verdict.reason == REASON_OK {
        settle_trade(ctx, amount_in, min_out, nonce, now)
    } else {
        record_refusal(ctx, amount_in, min_out, nonce, now, verdict)
    }
}

pub fn grant_trade_override(
    ctx: Context<GrantTradeOverride>,
    amount_in: u64,
    nonce: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(nonce != 0, VetoError::NonceRequired);
    require!(amount_in > 0, VetoError::AmountMustBePositive);
    require!(
        ctx.accounts.rule.status == STATUS_ACTIVE,
        VetoError::TradeRuleNotActive
    );
    require!(
        nonce > ctx.accounts.rule.last_nonce,
        VetoError::NonceAlreadySettled
    );
    require!(
        amount_in <= ctx.accounts.rule.remaining(),
        VetoError::OverrideAboveCap
    );

    let pool = ctx.accounts.rule.pool;
    let rule = &mut ctx.accounts.rule;
    rule.override_amount = amount_in;
    rule.override_nonce = nonce;

    ctx.accounts.ledger.load_mut()?.record(TradeEntry {
        ts: now,
        amount_in,
        amount_out: 0,
        min_out: 0,
        counterparty: pool,
        nonce,
        suggested_override: amount_in,
        kind: TRADE_KIND_OVERRIDE,
        reason: REASON_OK,
        _pad: [0; 6],
    });

    msg!(
        "VETO TRADE OVERRIDE amount_in={} nonce={}",
        amount_in,
        nonce
    );
    Ok(())
}

pub fn revoke_trade_rule(ctx: Context<RevokeTradeRule>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        ctx.accounts.rule.status != STATUS_REVOKED,
        VetoError::TradeRuleNotActive
    );

    let pool = ctx.accounts.rule.pool;
    let rule = &mut ctx.accounts.rule;
    rule.status = STATUS_REVOKED;
    rule.override_amount = 0;
    rule.override_nonce = 0;

    ctx.accounts.ledger.load_mut()?.record(TradeEntry {
        ts: now,
        amount_in: 0,
        amount_out: 0,
        min_out: 0,
        counterparty: pool,
        nonce: 0,
        suggested_override: 0,
        kind: TRADE_KIND_REVOKED,
        reason: REASON_OK,
        _pad: [0; 6],
    });

    // The SPL revoke fails on a frozen source. Skip it there as close does:
    // a frozen delegation is inert, and reopening requires a new approval.
    let rule_key = ctx.accounts.rule.key();
    let source = &ctx.accounts.source;
    if source.delegate == COption::Some(rule_key) && !source.is_frozen() {
        token::revoke(CpiContext::new(
            ctx.accounts.token_program.key(),
            token::Revoke {
                source: ctx.accounts.source.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ))?;
    }

    msg!(
        "VETO TRADE REVOKED spent={} of cap={}",
        ctx.accounts.rule.spent,
        ctx.accounts.rule.cap
    );
    Ok(())
}

/// Closable once the rule is not active or is past expiry. The second case
/// covers a source the owner already closed, which makes revoke impossible.
/// Revoke a source that still delegates to the rule unless it is frozen.
/// Frozen delegation is inert, and reopening the rule requires a new approval.
pub fn close_trade_rule(ctx: Context<CloseTradeRule>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        ctx.accounts.rule.status != STATUS_ACTIVE || now >= ctx.accounts.rule.expires_at,
        VetoError::TradeRuleStillActive
    );

    let rule_key = ctx.accounts.rule.key();
    let source = ctx.accounts.source.to_account_info();
    let should_revoke = *source.owner == spl_token::ID
        && spl_token::state::Account::unpack(&source.try_borrow_data()?)
            .map(|account| account.delegate == COption::Some(rule_key) && !account.is_frozen())
            .unwrap_or(false);
    if should_revoke {
        token::revoke(CpiContext::new(
            ctx.accounts.token_program.key(),
            token::Revoke {
                source,
                authority: ctx.accounts.owner.to_account_info(),
            },
        ))?;
    }

    msg!("VETO TRADE CLOSED revoked={}", should_revoke);
    Ok(())
}

struct Verdict {
    reason: u8,
    counterparty: Pubkey,
}

/// Pure policy evaluation. No writes and no CPI. The first broken rule wins.
fn evaluate<'info>(
    rule: &TradeRule,
    rule_key: Pubkey,
    source: &TokenAccount,
    destination: &AccountInfo<'info>,
    pool: &AccountInfo<'info>,
    pool_authority: &AccountInfo<'info>,
    pool_in_vault: &AccountInfo<'info>,
    pool_out_vault: &AccountInfo<'info>,
    pool_mint: &AccountInfo<'info>,
    pool_fee_account: &AccountInfo<'info>,
    exchange_program: &AccountInfo<'info>,
    amount_in: u64,
    nonce: u64,
    now: i64,
) -> Result<Verdict> {
    if rule.status != STATUS_ACTIVE {
        return Ok(pool_verdict(REASON_NOT_ACTIVE, rule));
    }
    if now >= rule.expires_at {
        return Ok(pool_verdict(REASON_EXPIRED, rule));
    }
    if amount_in == 0 {
        return Ok(pool_verdict(REASON_ZERO_AMOUNT, rule));
    }
    if nonce <= rule.last_nonce {
        return Ok(pool_verdict(REASON_STALE_NONCE, rule));
    }
    if destination.key() != rule.destination {
        return Ok(Verdict {
            reason: REASON_DESTINATION_NOT_ALLOWED,
            counterparty: destination.key(),
        });
    }

    let pinned = [
        (pool.key(), rule.pool),
        (pool_authority.key(), rule.pool_authority),
        (pool_in_vault.key(), rule.pool_in_vault),
        (pool_out_vault.key(), rule.pool_out_vault),
        (pool_mint.key(), rule.pool_mint),
        (pool_fee_account.key(), rule.pool_fee_account),
        (exchange_program.key(), rule.exchange_program),
    ];
    for (got, expected) in pinned {
        if got != expected {
            return Ok(Verdict {
                reason: REASON_POOL_NOT_ALLOWED,
                counterparty: got,
            });
        }
    }

    if amount_in > rule.effective_per_trade_max(nonce) {
        return Ok(pool_verdict(REASON_OVER_PER_TX_MAX, rule));
    }

    let window_spent = current_window_spent(rule, now)?;
    match window_spent.checked_add(amount_in) {
        Some(total) if total <= rule.daily_limit => {}
        _ => return Ok(pool_verdict(REASON_OVER_DAILY, rule)),
    }
    match rule.spent.checked_add(amount_in) {
        Some(total) if total <= rule.cap => {}
        _ => return Ok(pool_verdict(REASON_OVER_CAP, rule)),
    }

    if source.delegate != COption::Some(rule_key) {
        return Ok(pool_verdict(REASON_DELEGATE_MISSING, rule));
    }
    if source.delegated_amount < amount_in || source.amount < amount_in {
        return Ok(pool_verdict(REASON_INSUFFICIENT_FUNDS, rule));
    }

    let in_vault = unpack_token(pool_in_vault)?;
    let out_vault = unpack_token(pool_out_vault)?;
    if spot_below_floor(
        amount_in,
        in_vault.amount,
        out_vault.amount,
        rule.floor_num,
        rule.floor_den,
    ) {
        return Ok(pool_verdict(REASON_BELOW_FLOOR, rule));
    }

    let destination_account = unpack_token(destination)?;
    if source.is_frozen() || destination_account.is_frozen() {
        return Ok(pool_verdict(REASON_ACCOUNT_FROZEN, rule));
    }

    Ok(pool_verdict(REASON_OK, rule))
}

fn pool_verdict(reason: u8, rule: &TradeRule) -> Verdict {
    Verdict {
        reason,
        counterparty: rule.pool,
    }
}

/// Retain the current hour and 24 preceding hours, including the whole oldest
/// bucket. Every sale in the last 24 hours is included. Future buckets also
/// count defensively if the clock moves backwards.
pub fn current_window_spent(rule: &TradeRule, now: i64) -> Result<u64> {
    let oldest = now.div_euclid(TRADE_BUCKET_SECS) - 24;
    rule.daily_buckets
        .iter()
        .filter(|bucket| bucket.hour >= oldest)
        .try_fold(0u64, |total, bucket| {
            total
                .checked_add(bucket.amount)
                .ok_or(error!(VetoError::MathOverflow))
        })
}

fn commit_window(rule: &mut TradeRule, amount_in: u64, now: i64) -> Result<()> {
    let hour = now.div_euclid(TRADE_BUCKET_SECS);
    let slot = hour.rem_euclid(TRADE_BUCKET_COUNT as i64) as usize;
    let bucket = &mut rule.daily_buckets[slot];
    if bucket.hour != hour {
        // Never discard a future bucket after a backwards clock adjustment.
        require!(
            bucket.amount == 0 || bucket.hour < hour - 24,
            VetoError::MathOverflow
        );
        *bucket = TradeBucket { hour, amount: 0 };
    }
    bucket.amount = bucket
        .amount
        .checked_add(amount_in)
        .ok_or(error!(VetoError::MathOverflow))?;
    Ok(())
}

/// Trade fee the pinned exchange takes out of the input, per `FEE_DEN`.
pub const TRADE_FEE_NUM: u64 = 25;
/// Owner trade fee the pinned exchange takes out of the input, per `FEE_DEN`.
pub const OWNER_TRADE_FEE_NUM: u64 = 5;
pub const FEE_DEN: u64 = 10_000;

/// Input left after the schedule verified at open: trade 25/10000 plus
/// owner trade 5/10000, each
/// rounded down on the input with a minimum of one unit for nonzero input.
pub fn input_after_fees(amount_in: u64) -> u64 {
    let amount = u128::from(amount_in);
    let den = u128::from(FEE_DEN);
    let minimum = u128::from(amount_in > 0);
    let trade_fee = (amount * u128::from(TRADE_FEE_NUM) / den).max(minimum);
    let owner_fee = (amount * u128::from(OWNER_TRADE_FEE_NUM) / den).max(minimum);
    // A one-unit input cannot cover both minimum fees and has no usable input.
    amount.saturating_sub(trade_fee + owner_fee) as u64
}

/// `net * out_reserve / (in_reserve + net)`, where `net` is the input after
/// the exchange fees.
///
/// For the pinned curve and the fee schedule above this quote is exact, not
/// an optimistic bound. A floor failure here is certain. The floor itself is
/// compared with the gross `amount_in`, since that is what the owner gives up.
pub fn spot_below_floor(
    amount_in: u64,
    in_reserve: u64,
    out_reserve: u64,
    floor_num: u64,
    floor_den: u64,
) -> bool {
    let net = u128::from(input_after_fees(amount_in));
    let denom = u128::from(in_reserve).saturating_add(net);
    if denom == 0 || floor_den == 0 {
        return true;
    }
    let quote = net.saturating_mul(u128::from(out_reserve)) / denom;
    let amount = u128::from(amount_in);
    quote.saturating_mul(u128::from(floor_den)) < amount.saturating_mul(u128::from(floor_num))
}

fn floor_bound(amount_in: u64, floor_num: u64, floor_den: u64) -> Result<u64> {
    let den = u128::from(floor_den);
    require!(den > 0, VetoError::FloorDenominatorRequired);
    let num = u128::from(amount_in)
        .checked_mul(u128::from(floor_num))
        .ok_or(error!(VetoError::MathOverflow))?;
    let ceil = num
        .checked_add(den - 1)
        .ok_or(error!(VetoError::MathOverflow))?
        / den;
    u64::try_from(ceil).map_err(|_| error!(VetoError::MathOverflow))
}

fn settle_trade(
    ctx: Context<Trade>,
    amount_in: u64,
    min_out: u64,
    nonce: u64,
    now: i64,
) -> Result<()> {
    require!(
        ctx.accounts.rule.exchange_kind == EXCHANGE_KIND_SPL_TOKEN_SWAP,
        VetoError::ExchangeNotSupported
    );
    require_keys_eq!(
        ctx.accounts.rule.exchange_program,
        SPL_TOKEN_SWAP_ID,
        VetoError::ExchangeNotSupported
    );

    let effective_min = core::cmp::max(
        min_out,
        floor_bound(
            amount_in,
            ctx.accounts.rule.floor_num,
            ctx.accounts.rule.floor_den,
        )?,
    );
    let source_before = ctx.accounts.source.amount;
    let dest_before = unpack_token(&ctx.accounts.destination.to_account_info())?.amount;

    let owner = ctx.accounts.rule.owner;
    let rule_id = ctx.accounts.rule.rule_id;
    let bump = ctx.accounts.rule.bump;
    let pool_key = ctx.accounts.rule.pool;

    swap_exact_in(
        ctx.accounts.exchange_program.to_account_info(),
        ctx.accounts.pool.to_account_info(),
        ctx.accounts.pool_authority.to_account_info(),
        ctx.accounts.rule.to_account_info(),
        ctx.accounts.source.to_account_info(),
        ctx.accounts.pool_in_vault.to_account_info(),
        ctx.accounts.pool_out_vault.to_account_info(),
        ctx.accounts.destination.to_account_info(),
        ctx.accounts.pool_mint.to_account_info(),
        ctx.accounts.pool_fee_account.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        amount_in,
        effective_min,
        owner,
        rule_id,
        bump,
    )?;

    ctx.accounts.source.reload()?;
    let source_after = ctx.accounts.source.amount;
    let dest_after = unpack_token(&ctx.accounts.destination.to_account_info())?.amount;
    // The exchange's curve rounding can consume less than the requested input.
    // Charge only the observed debit, while retaining the requested output floor.
    let amount_in = source_before
        .checked_sub(source_after)
        .filter(|delta| *delta > 0 && *delta <= amount_in)
        .ok_or(error!(VetoError::TradeDeltaMismatch))?;
    let amount_out = dest_after
        .checked_sub(dest_before)
        .ok_or(error!(VetoError::TradeDeltaMismatch))?;
    require!(amount_out >= effective_min, VetoError::TradeDeltaMismatch);

    let rule = &mut ctx.accounts.rule;
    commit_window(rule, amount_in, now)?;
    rule.spent = rule
        .spent
        .checked_add(amount_in)
        .ok_or(error!(VetoError::MathOverflow))?;
    rule.trade_count = rule.trade_count.saturating_add(1);
    rule.last_nonce = nonce;
    if rule.override_nonce == nonce {
        rule.override_nonce = 0;
        rule.override_amount = 0;
    }
    if rule.spent >= rule.cap {
        rule.status = STATUS_EXHAUSTED;
    }
    let remaining_today = rule
        .daily_limit
        .saturating_sub(current_window_spent(rule, now)?);
    let spent = rule.spent;
    let cap = rule.cap;
    let rule_key = rule.key();

    ctx.accounts.ledger.load_mut()?.record(TradeEntry {
        ts: now,
        amount_in,
        amount_out,
        min_out,
        counterparty: pool_key,
        nonce,
        suggested_override: 0,
        kind: TRADE_KIND_TRADED,
        reason: REASON_OK,
        _pad: [0; 6],
    });

    msg!(
        "VETO TRADED amount_in={} amount_out={} spent={} of cap={} remaining_today={}",
        amount_in,
        amount_out,
        spent,
        cap,
        remaining_today
    );
    emit!(Traded {
        rule: rule_key,
        amount_in,
        amount_out,
        nonce,
        spent,
    });
    Ok(())
}

fn record_refusal(
    ctx: Context<Trade>,
    amount_in: u64,
    min_out: u64,
    nonce: u64,
    now: i64,
    verdict: Verdict,
) -> Result<()> {
    let suggestion = suggested_override(&ctx.accounts.rule, verdict.reason, amount_in, now)?;
    let per_trade_max = ctx.accounts.rule.effective_per_trade_max(nonce);
    let remaining = ctx.accounts.rule.remaining();
    let remaining_today = ctx
        .accounts
        .rule
        .daily_limit
        .saturating_sub(current_window_spent(&ctx.accounts.rule, now)?);

    let rule_key = ctx.accounts.rule.key();
    {
        let rule = &mut ctx.accounts.rule;
        if verdict.reason == REASON_EXPIRED && rule.status == STATUS_ACTIVE {
            rule.status = STATUS_EXPIRED;
        }
        rule.refusal_count = rule.refusal_count.saturating_add(1);
    }

    ctx.accounts.ledger.load_mut()?.record(TradeEntry {
        ts: now,
        amount_in,
        amount_out: 0,
        min_out,
        counterparty: verdict.counterparty,
        nonce,
        suggested_override: suggestion,
        kind: TRADE_KIND_REFUSED,
        reason: verdict.reason,
        _pad: [0; 6],
    });

    msg!(
        "VETO TRADE REFUSED reason={} ({}) amount_in={} per_trade_max={} remaining={} remaining_today={} override_to_clear={}",
        verdict.reason,
        reason_text(verdict.reason),
        amount_in,
        per_trade_max,
        remaining,
        remaining_today,
        suggestion
    );
    emit!(TradeRefused {
        rule: rule_key,
        amount_in,
        min_out,
        nonce,
        reason: verdict.reason,
        suggested_override: suggestion,
    });
    Ok(())
}

/// The one-shot per-trade ceiling that would clear this charge, or zero when
/// the amount does not fit the remaining cap and the remaining day. An
/// override never lifts either of those.
fn suggested_override(rule: &TradeRule, reason: u8, amount_in: u64, now: i64) -> Result<u64> {
    if reason != REASON_OVER_PER_TX_MAX {
        return Ok(0);
    }
    let today = rule
        .daily_limit
        .saturating_sub(current_window_spent(rule, now)?);
    if amount_in <= rule.remaining() && amount_in <= today {
        Ok(amount_in)
    } else {
        Ok(0)
    }
}

fn reason_text(reason: u8) -> &'static str {
    match reason {
        REASON_NOT_ACTIVE => "rule not active",
        REASON_EXPIRED => "past expiry",
        REASON_STALE_NONCE => "nonce already settled",
        REASON_OVER_PER_TX_MAX => "over per-trade maximum",
        REASON_OVER_CAP => "over remaining cap",
        REASON_DELEGATE_MISSING => "delegation withdrawn",
        REASON_INSUFFICIENT_FUNDS => "insufficient funds",
        REASON_ZERO_AMOUNT => "zero amount",
        REASON_ACCOUNT_FROZEN => "account frozen",
        REASON_DESTINATION_NOT_ALLOWED => "destination not allowed",
        REASON_POOL_NOT_ALLOWED => "pool account not allowed",
        REASON_OVER_DAILY => "over daily limit",
        REASON_BELOW_FLOOR => "below price floor",
        _ => "unknown",
    }
}

fn require_pool_shape(ctx: &Context<OpenTradeRule>) -> Result<()> {
    require_keys_eq!(
        *ctx.accounts.pool.to_account_info().owner,
        ctx.accounts.exchange_program.key(),
        VetoError::PoolAccountMismatch
    );

    // Versioned SPL token-swap v2 state: version, initialized, bump, seven
    // pubkeys, eight fee words, curve tag and 32 curve parameter bytes.
    let pool_info = ctx.accounts.pool.to_account_info();
    let data = pool_info.try_borrow_data()?;
    require!(
        data.len() == 324 && data[0] == 1 && data[1] == 1,
        VetoError::PoolAccountMismatch
    );
    let expected_fees = [
        TRADE_FEE_NUM,
        FEE_DEN,
        OWNER_TRADE_FEE_NUM,
        FEE_DEN,
        0,
        0,
        20,
        100,
    ];
    for (index, expected) in expected_fees.iter().enumerate() {
        let offset = 227 + index * 8;
        require!(
            data[offset..offset + 8] == expected.to_le_bytes(),
            VetoError::PoolAccountMismatch
        );
    }
    require!(data[291] == 0, VetoError::PoolAccountMismatch);
    let expected_keys = [
        spl_token::ID,
        ctx.accounts.pool_in_vault.key(),
        ctx.accounts.pool_out_vault.key(),
        ctx.accounts.pool_mint.key(),
        ctx.accounts.in_mint.key(),
        ctx.accounts.out_mint.key(),
        ctx.accounts.pool_fee_account.key(),
    ];
    // Pools may be traded in either direction.
    let forward = data[35..67] == expected_keys[1].to_bytes();
    let ordered = if forward {
        expected_keys
    } else {
        [
            expected_keys[0],
            expected_keys[2],
            expected_keys[1],
            expected_keys[3],
            expected_keys[5],
            expected_keys[4],
            expected_keys[6],
        ]
    };
    for (index, expected) in ordered.iter().enumerate() {
        let offset = 3 + index * 32;
        require!(
            data[offset..offset + 32] == expected.to_bytes(),
            VetoError::PoolAccountMismatch
        );
    }
    let authority = Pubkey::create_program_address(
        &[pool_info.key.as_ref(), &[data[2]]],
        &ctx.accounts.exchange_program.key(),
    )
    .map_err(|_| error!(VetoError::PoolAccountMismatch))?;
    require_keys_eq!(
        authority,
        ctx.accounts.pool_authority.key(),
        VetoError::PoolAccountMismatch
    );

    let authority = ctx.accounts.pool_authority.key();
    let in_vault = unpack_token(&ctx.accounts.pool_in_vault.to_account_info())?;
    require_keys_eq!(
        in_vault.mint,
        ctx.accounts.in_mint.key(),
        VetoError::PoolAccountMismatch
    );
    require_keys_eq!(in_vault.owner, authority, VetoError::PoolAccountMismatch);

    let out_vault = unpack_token(&ctx.accounts.pool_out_vault.to_account_info())?;
    require_keys_eq!(
        out_vault.mint,
        ctx.accounts.out_mint.key(),
        VetoError::PoolAccountMismatch
    );
    require_keys_eq!(out_vault.owner, authority, VetoError::PoolAccountMismatch);

    unpack_mint(&ctx.accounts.pool_mint.to_account_info())?;
    let fee = unpack_token(&ctx.accounts.pool_fee_account.to_account_info())?;
    require_keys_eq!(
        fee.mint,
        ctx.accounts.pool_mint.key(),
        VetoError::PoolAccountMismatch
    );
    Ok(())
}

/// A closed account, or one that is not an SPL token account, is
/// `NotATokenAccount`. That covers a destination the owner closed after open.
fn unpack_token(info: &AccountInfo) -> Result<spl_token::state::Account> {
    require_keys_eq!(*info.owner, spl_token::ID, VetoError::NotATokenAccount);
    let data = info.try_borrow_data()?;
    spl_token::state::Account::unpack(&data).map_err(|_| error!(VetoError::NotATokenAccount))
}

fn unpack_mint(info: &AccountInfo) -> Result<()> {
    require_keys_eq!(*info.owner, spl_token::ID, VetoError::PoolAccountMismatch);
    let data = info.try_borrow_data()?;
    spl_token::state::Mint::unpack(&data).map_err(|_| error!(VetoError::PoolAccountMismatch))?;
    Ok(())
}

fn swap_exact_in<'info>(
    exchange_program: AccountInfo<'info>,
    pool: AccountInfo<'info>,
    pool_authority: AccountInfo<'info>,
    rule: AccountInfo<'info>,
    source: AccountInfo<'info>,
    pool_in_vault: AccountInfo<'info>,
    pool_out_vault: AccountInfo<'info>,
    destination: AccountInfo<'info>,
    pool_mint: AccountInfo<'info>,
    pool_fee_account: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    amount_in: u64,
    minimum_out: u64,
    owner: Pubkey,
    rule_id: u64,
    bump: u8,
) -> Result<()> {
    let mut data = [0u8; 17];
    data[0] = 1;
    data[1..9].copy_from_slice(&amount_in.to_le_bytes());
    data[9..17].copy_from_slice(&minimum_out.to_le_bytes());

    let ix = Instruction {
        program_id: exchange_program.key(),
        accounts: vec![
            AccountMeta::new_readonly(pool.key(), false),
            AccountMeta::new_readonly(pool_authority.key(), false),
            AccountMeta::new_readonly(rule.key(), true),
            AccountMeta::new(source.key(), false),
            AccountMeta::new(pool_in_vault.key(), false),
            AccountMeta::new(pool_out_vault.key(), false),
            AccountMeta::new(destination.key(), false),
            AccountMeta::new(pool_mint.key(), false),
            AccountMeta::new(pool_fee_account.key(), false),
            AccountMeta::new_readonly(token_program.key(), false),
        ],
        data: data.to_vec(),
    };

    let rule_id_bytes = rule_id.to_le_bytes();
    let bump_arr = [bump];
    let seeds: &[&[u8]] = &[b"trade", owner.as_ref(), &rule_id_bytes, &bump_arr];
    invoke_signed(
        &ix,
        &[
            pool,
            pool_authority,
            rule,
            source,
            pool_in_vault,
            pool_out_vault,
            destination,
            pool_mint,
            pool_fee_account,
            token_program,
        ],
        &[seeds],
    )
    .map_err(Into::into)
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OpenTradeRuleArgs {
    pub rule_id: u64,
    pub agent: Pubkey,
    pub exchange_kind: u8,
    pub cap: u64,
    pub per_trade_max: u64,
    pub daily_limit: u64,
    pub floor_num: u64,
    pub floor_den: u64,
    pub expires_at: i64,
    pub purpose: String,
}

#[event]
pub struct Traded {
    pub rule: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub nonce: u64,
    pub spent: u64,
}

#[event]
pub struct TradeRefused {
    pub rule: Pubkey,
    pub amount_in: u64,
    pub min_out: u64,
    pub nonce: u64,
    pub reason: u8,
    pub suggested_override: u64,
}

#[cfg(test)]
mod quote_tests {
    use super::{input_after_fees, spot_below_floor};

    #[test]
    fn the_spot_quote_refuses_a_floor_the_curve_cannot_clear() {
        let amount_in = 10_000_000u64;
        let in_reserve = 1_000_000_000_000u64;
        let out_reserve = 1_000_000_000_000_000u64;
        assert!(spot_below_floor(
            amount_in,
            in_reserve,
            out_reserve,
            1000,
            1
        ));
        assert!(!spot_below_floor(amount_in, in_reserve, out_reserve, 1, 1));
    }

    #[test]
    fn the_quote_takes_the_thirty_basis_point_fee_out_of_the_input() {
        assert_eq!(input_after_fees(10_000), 9_970);
        assert_eq!(input_after_fees(0), 0);
        assert_eq!(
            input_after_fees(u64::MAX),
            u64::MAX - u64::MAX / 400 - u64::MAX / 2000
        );
        // A floor at the fee-free quote is refused, one at the net quote is not.
        let amount_in = 10_000_000u64;
        let (in_reserve, out_reserve) = (1_000_000_000_000u64, 1_000_000_000_000_000u64);
        let gross = u128::from(amount_in) * u128::from(out_reserve)
            / (u128::from(in_reserve) + u128::from(amount_in));
        let net_in = u128::from(input_after_fees(amount_in));
        let net = net_in * u128::from(out_reserve) / (u128::from(in_reserve) + net_in);
        assert!(spot_below_floor(
            amount_in,
            in_reserve,
            out_reserve,
            gross as u64,
            amount_in
        ));
        assert!(!spot_below_floor(
            amount_in,
            in_reserve,
            out_reserve,
            net as u64,
            amount_in
        ));
    }
}
