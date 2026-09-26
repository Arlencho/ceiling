//! Conservative bounded rolling accounting shared by trade rules and Hold.

use anchor_lang::prelude::*;

pub const WINDOW_SECS: i64 = 24 * 60 * 60;
pub const BUCKET_SECS: i64 = 60 * 60;
pub const BUCKET_COUNT: usize = 25;

// Preserve the existing IDL type name used by trade clients.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct TradeBucket {
    pub hour: i64,
    pub amount: u64,
}

/// Include the whole oldest hour and any future buckets after a clock rewind.
/// This never undercounts a rolling day; recovery may take up to 25 hours.
pub fn spent(buckets: &[TradeBucket; BUCKET_COUNT], now: i64) -> Option<u64> {
    let oldest = now.div_euclid(BUCKET_SECS) - 24;
    buckets
        .iter()
        .filter(|bucket| bucket.hour >= oldest)
        .try_fold(0u64, |total, bucket| total.checked_add(bucket.amount))
}

pub fn commit(buckets: &mut [TradeBucket; BUCKET_COUNT], amount: u64, now: i64) -> Option<()> {
    let hour = now.div_euclid(BUCKET_SECS);
    let slot = hour.rem_euclid(BUCKET_COUNT as i64) as usize;
    let bucket = &mut buckets[slot];
    if bucket.hour != hour {
        // Do not discard live or future accounting after a clock rewind.
        if bucket.amount != 0 && bucket.hour >= hour - 24 {
            return None;
        }
        *bucket = TradeBucket { hour, amount: 0 };
    }
    bucket.amount = bucket.amount.checked_add(amount)?;
    Some(())
}

/// Delayed or jointly approved Hold payments must not gain a new failure mode.
/// Saturation blocks all further everyday payments until the bucket expires.
/// A colliding future bucket keeps its later hour, conservatively retaining
/// both payments after a backwards clock adjustment.
pub fn record_release(buckets: &mut [TradeBucket; BUCKET_COUNT], amount: u64, now: i64) {
    let hour = now.div_euclid(BUCKET_SECS);
    let slot = hour.rem_euclid(BUCKET_COUNT as i64) as usize;
    let bucket = &mut buckets[slot];
    if bucket.amount == 0 || bucket.hour < hour - 24 {
        *bucket = TradeBucket { hour, amount: 0 };
    }
    bucket.amount = bucket.amount.saturating_add(amount);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approved_releases_saturate_without_reopening_the_everyday_door() {
        let mut buckets = [TradeBucket::default(); BUCKET_COUNT];
        record_release(&mut buckets, u64::MAX, 3601);
        record_release(&mut buckets, 1, 3602);
        assert_eq!(spent(&buckets, 3602), Some(u64::MAX));
        assert_eq!(spent(&buckets, 25 * 3600), Some(u64::MAX));
        assert_eq!(spent(&buckets, 26 * 3600), Some(0));
    }

    #[test]
    fn approved_releases_keep_future_spend_after_a_clock_rewind() {
        let mut buckets = [TradeBucket::default(); BUCKET_COUNT];
        record_release(&mut buckets, 40, 25 * 3600);
        record_release(&mut buckets, 10, 0);
        assert_eq!(spent(&buckets, 0), Some(50));
        assert_eq!(spent(&buckets, 49 * 3600), Some(50));
        assert_eq!(spent(&buckets, 50 * 3600), Some(0));
    }
}
