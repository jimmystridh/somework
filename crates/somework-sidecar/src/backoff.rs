//! Bounded exponential backoff with jitter for every reconnect and retry loop, so a recovering domain is not hit by all
//! workers in lockstep.

use std::time::Duration;

#[derive(Debug, Clone)]
pub struct Backoff {
    base: Duration,
    max: Duration,
    attempt: u32,
}

impl Backoff {
    pub fn new(base: Duration, max: Duration) -> Self {
        Self { base, max, attempt: 0 }
    }

    /// The delay ceiling for the current attempt: `base * 2^attempt`, never above `max`.
    pub fn ceiling(&self) -> Duration {
        self.base.saturating_mul(1u32.checked_shl(self.attempt).unwrap_or(u32::MAX)).min(self.max)
    }

    /// A delay uniformly distributed over the upper half of the ceiling, then advances to the next attempt.
    pub fn next_delay(&mut self) -> Duration {
        let ceiling = self.ceiling();
        self.attempt = self.attempt.saturating_add(1);
        ceiling.mul_f64(0.5 + rand::random::<f64>() * 0.5)
    }

    pub fn reset(&mut self) {
        self.attempt = 0;
    }
}

/// Spreads a fixed interval by up to ±20% so periodic sweeps of many workers do not align.
pub fn jittered(interval: Duration) -> Duration {
    interval.mul_f64(0.8 + rand::random::<f64>() * 0.4)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delays_grow_exponentially_stay_jittered_and_are_capped() {
        let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(30));
        let mut ceilings = vec![];
        for _ in 0..8 {
            let ceiling = backoff.ceiling();
            let delay = backoff.next_delay();
            assert!(delay >= ceiling / 2 && delay <= ceiling, "{delay:?} outside [{:?}, {ceiling:?}]", ceiling / 2);
            ceilings.push(ceiling.as_secs());
        }
        assert_eq!(ceilings, [1, 2, 4, 8, 16, 30, 30, 30]);
    }

    #[test]
    fn reset_starts_over_and_huge_attempt_counts_do_not_overflow() {
        let mut backoff = Backoff::new(Duration::from_millis(500), Duration::from_secs(10));
        for _ in 0..200 {
            backoff.next_delay();
        }
        assert_eq!(backoff.ceiling(), Duration::from_secs(10));
        backoff.reset();
        assert_eq!(backoff.ceiling(), Duration::from_millis(500));
    }

    #[test]
    fn periodic_intervals_are_spread() {
        let spread: Vec<Duration> = (0..50).map(|_| jittered(Duration::from_secs(20))).collect();
        assert!(spread.iter().all(|d| *d >= Duration::from_secs(16) && *d <= Duration::from_secs(24)));
        assert!(spread.windows(2).any(|w| w[0] != w[1]));
    }
}
