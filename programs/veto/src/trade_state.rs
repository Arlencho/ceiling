//! Account layout for a trade rule.
//!
//! Separate from `Mandate`, `Ledger`, `HoldVault` and `HoldLedger`. Those
//! layouts are not used here and are not modified.

use anchor_lang::prelude::*;

use crate::state::PURPOSE_MAX_LEN;

/// Decisions kept on the trade ledger. Older ones fall out of the ring.
pub const TRADE_LEDGER_CAPACITY: usize = 32;

/// Every rolling interval of this length must stay within the daily limit.
pub const TRADE_WINDOW_SECS: i64 = 24 * 60 * 60;
pub const TRADE_BUCKET_SECS: i64 = 60 * 60;
pub const TRADE_BUCKET_COUNT: usize = 25;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct TradeBucket {
    pub hour: i64,
    pub amount: u64,
}

/// `exchange_kind` for the SPL token-swap program at `SPL_TOKEN_SWAP_ID`.
pub const EXCHANGE_KIND_SPL_TOKEN_SWAP: u8 = 0;

/// Devnet SPL token-swap v2. Kind 0 is this program and no other.
pub const SPL_TOKEN_SWAP_ID: Pubkey = pubkey!("SwaPpA9LAaLfeLi3a68M4DjnLqgtticKg6CnyNwgAC8");

// Record kinds.
pub const TRADE_KIND_OPENED: u8 = 0;
pub const TRADE_KIND_TRADED: u8 = 1;
pub const TRADE_KIND_REFUSED: u8 = 2;
pub const TRADE_KIND_OVERRIDE: u8 = 3;
pub const TRADE_KIND_REVOKED: u8 = 4;

/// The agent named a destination other than the one pinned at open.
pub const REASON_DESTINATION_NOT_ALLOWED: u8 = 11;
/// The agent named a pool account other than the one pinned at open.
pub const REASON_POOL_NOT_ALLOWED: u8 = 12;
/// The trade would push the conservative rolling daily total over `daily_limit`.
pub const REASON_OVER_DAILY: u8 = 13;
/// The spot quote is already under the price floor.
pub const REASON_BELOW_FLOOR: u8 = 14;

/// A permission to swap, owned by the human and enforced by this program.
///
/// The owner signs `open_trade_rule`, `grant_trade_override`, `revoke_trade_rule`
/// and `close_trade_rule`. The agent signs `trade` and can do nothing else.
#[account]
#[derive(InitSpace)]
pub struct TradeRule {
    pub owner: Pubkey,
    /// Key allowed to submit trades. Holds authority, never ownership.
    pub agent: Pubkey,
    /// The owner's input token account. Delegated to this rule for `cap`.
    pub source: Pubkey,
    /// The owner's output token account, pinned at open.
    pub destination: Pubkey,
    pub in_mint: Pubkey,
    pub out_mint: Pubkey,
    pub exchange_program: Pubkey,
    /// 0 is the SPL token-swap program named by `SPL_TOKEN_SWAP_ID`.
    pub exchange_kind: u8,
    pub pool: Pubkey,
    pub pool_authority: Pubkey,
    pub pool_in_vault: Pubkey,
    pub pool_out_vault: Pubkey,
    pub pool_mint: Pubkey,
    /// Stored at open and compared on every trade. The fee owner is not hardcoded.
    pub pool_fee_account: Pubkey,
    pub rule_id: u64,
    /// Total input that may ever be sold, in base units.
    pub cap: u64,
    /// Input sold so far, in base units. Never exceeds `cap`.
    pub spent: u64,
    /// Largest single trade allowed, in base units, before a one-shot override.
    pub per_trade_max: u64,
    /// Most input that may be sold in any rolling 24 hour interval.
    pub daily_limit: u64,
    /// Current hour plus the preceding 24 hours. This retains a partial oldest
    /// hour conservatively, so allowance may take up to 25 hours to recover.
    pub daily_buckets: [TradeBucket; TRADE_BUCKET_COUNT],
    /// Minimum output per unit of input, as `floor_num / floor_den`.
    pub floor_num: u64,
    pub floor_den: u64,
    pub expires_at: i64,
    /// One-shot per-trade ceiling the owner granted for a specific nonce.
    pub override_amount: u64,
    /// Nonce the override applies to. Zero means no override is pending.
    pub override_nonce: u64,
    /// Highest nonce that has been traded. A refusal does not advance it.
    pub last_nonce: u64,
    #[max_len(PURPOSE_MAX_LEN)]
    pub purpose: String,
    pub status: u8,
    pub trade_count: u32,
    pub refusal_count: u32,
    pub bump: u8,
}

impl TradeRule {
    /// The per-trade ceiling for this nonce. An override raises that ceiling
    /// only. It does not raise `daily_limit` or `cap`.
    pub fn effective_per_trade_max(&self, nonce: u64) -> u64 {
        if self.override_nonce != 0 && self.override_nonce == nonce {
            core::cmp::max(self.per_trade_max, self.override_amount)
        } else {
            self.per_trade_max
        }
    }

    pub fn remaining(&self) -> u64 {
        self.cap.saturating_sub(self.spent)
    }
}

/// One trade decision. `repr(C)` with explicit padding, because the ledger is
/// zero-copy and the ring must never be deserialized onto the stack.
///
/// `counterparty` is the pool on a paid trade and on most refusals. On reason
/// 11 or 12 it is the account the agent tried.
#[zero_copy]
#[derive(Debug, PartialEq)]
pub struct TradeEntry {
    pub ts: i64,
    pub amount_in: u64,
    pub amount_out: u64,
    pub min_out: u64,
    pub counterparty: Pubkey,
    pub nonce: u64,
    pub suggested_override: u64,
    pub kind: u8,
    pub reason: u8,
    pub _pad: [u8; 6],
}

/// A ring of the most recent trade decisions, including refusals.
#[account(zero_copy)]
pub struct TradeLedger {
    pub rule: Pubkey,
    /// Total entries ever written, including those the ring has overwritten.
    pub total: u32,
    /// Index the next entry is written to.
    pub head: u16,
    pub bump: u8,
    pub _pad: [u8; 1],
    pub entries: [TradeEntry; TRADE_LEDGER_CAPACITY],
}

impl TradeLedger {
    pub fn record(&mut self, entry: TradeEntry) {
        let slot = self.head as usize % TRADE_LEDGER_CAPACITY;
        self.entries[slot] = entry;
        self.head = ((slot + 1) % TRADE_LEDGER_CAPACITY) as u16;
        self.total = self.total.saturating_add(1);
    }
}
