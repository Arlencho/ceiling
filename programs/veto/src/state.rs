use anchor_lang::prelude::*;

/// Maximum characters of human-readable purpose text stored on chain.
pub const PURPOSE_MAX_LEN: usize = 64;

/// Number of decisions kept in the on-chain ring buffer.
pub const LEDGER_CAPACITY: usize = 32;

// Mandate lifecycle.
pub const STATUS_ACTIVE: u8 = 0;
pub const STATUS_REVOKED: u8 = 1;
pub const STATUS_EXHAUSTED: u8 = 2;
pub const STATUS_EXPIRED: u8 = 3;

// Ledger entry kinds.
pub const KIND_OPENED: u8 = 0;
pub const KIND_PAID: u8 = 1;
pub const KIND_REFUSED: u8 = 2;
pub const KIND_OVERRIDE: u8 = 3;
pub const KIND_REVOKED: u8 = 4;

// Refusal reasons. Zero means the charge was allowed.
pub const REASON_OK: u8 = 0;
pub const REASON_NOT_ACTIVE: u8 = 1;
pub const REASON_EXPIRED: u8 = 2;
pub const REASON_STALE_NONCE: u8 = 3;
pub const REASON_MERCHANT_NOT_ALLOWED: u8 = 4;
pub const REASON_OVER_PER_TX_MAX: u8 = 5;
pub const REASON_OVER_CAP: u8 = 6;
pub const REASON_DELEGATE_MISSING: u8 = 7;
pub const REASON_INSUFFICIENT_FUNDS: u8 = 8;
pub const REASON_ZERO_AMOUNT: u8 = 9;
pub const REASON_ACCOUNT_FROZEN: u8 = 10;

/// A permission to spend, owned by the human and enforced by this program.
///
/// The owner key never leaves Seed Vault and signs only `open_mandate`,
/// `grant_override`, `revoke_mandate` and `close_mandate`. The agent key signs
/// `charge` and can do nothing else: it cannot widen any limit, change the
/// merchant, extend the expiry, or move funds outside this account's rules.
#[account]
#[derive(InitSpace)]
pub struct Mandate {
    /// Human who owns the funds and the mandate.
    pub owner: Pubkey,
    /// Key allowed to submit charges. Holds authority, never ownership.
    pub agent: Pubkey,
    /// Asset this mandate governs.
    pub mint: Pubkey,
    /// The owner's token account. Funds stay here until a charge is allowed.
    pub source: Pubkey,
    /// The only wallet that may receive funds under this mandate.
    pub merchant: Pubkey,
    /// Distinguishes several mandates held by the same owner.
    pub mandate_id: u64,
    /// Total that may ever be spent, in base units.
    pub cap: u64,
    /// Spent so far, in base units. Never exceeds `cap`.
    pub spent: u64,
    /// Largest single payment allowed, in base units.
    pub per_tx_max: u64,
    /// Unix seconds after which nothing may be spent.
    pub expires_at: i64,
    /// One-shot allowance the owner granted for a specific charge.
    pub override_amount: u64,
    /// Nonce the override applies to. Zero means no override is pending.
    pub override_nonce: u64,
    /// Highest nonce that has been paid. Blocks replay of a settled charge.
    pub last_nonce: u64,
    /// What the money is for, in the owner's own words, fixed at creation.
    #[max_len(PURPOSE_MAX_LEN)]
    pub purpose: String,
    pub status: u8,
    pub spend_count: u32,
    pub refusal_count: u32,
    pub bump: u8,
}

impl Mandate {
    /// The per-payment ceiling for this charge, taking a matching one-shot
    /// override into account. An override raises the per-payment ceiling only.
    /// It can never raise `cap`, so the total the owner committed to is
    /// absolute.
    pub fn effective_per_tx_max(&self, nonce: u64) -> u64 {
        if self.override_nonce != 0 && self.override_nonce == nonce {
            core::cmp::max(self.per_tx_max, self.override_amount)
        } else {
            self.per_tx_max
        }
    }

    pub fn remaining(&self) -> u64 {
        self.cap.saturating_sub(self.spent)
    }
}

/// One decision, paid or refused, exactly as the program made it.
///
/// `repr(C)` with explicit padding, because the ledger is a zero-copy account:
/// the ring is larger than the BPF stack frame and must never be deserialized
/// onto it.
#[zero_copy]
#[derive(Debug, PartialEq)]
pub struct Entry {
    pub ts: i64,
    pub amount: u64,
    pub counterparty: Pubkey,
    pub nonce: u64,
    /// For a refusal, the one-shot override that would have cleared this exact
    /// charge, or zero when no override could. A decline that tells you how to
    /// proceed is the difference between a limit and an answer.
    pub suggested_override: u64,
    pub kind: u8,
    pub reason: u8,
    pub _pad: [u8; 6],
}

/// A ring of the most recent decisions. Refusals are recorded here with the
/// same weight as payments, which is the point of the whole program.
///
/// The ring is the authoritative recent window. Longer history is rebuilt by
/// indexing `Paid` and `Refused` events from transaction logs, so a busy week
/// wrapping the ring costs nothing.
#[account(zero_copy)]
pub struct Ledger {
    pub mandate: Pubkey,
    /// Total entries ever written, including those the ring has overwritten.
    pub total: u32,
    /// Index the next entry is written to.
    pub head: u16,
    pub bump: u8,
    pub _pad: [u8; 1],
    pub entries: [Entry; LEDGER_CAPACITY],
}

impl Ledger {
    pub fn record(&mut self, entry: Entry) {
        let slot = self.head as usize % LEDGER_CAPACITY;
        self.entries[slot] = entry;
        self.head = ((slot + 1) % LEDGER_CAPACITY) as u16;
        self.total = self.total.saturating_add(1);
    }
}
