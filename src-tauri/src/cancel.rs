//! The stop signal for one in-flight turn.
//!
//! Two ways to observe it, because the adapters need different ones. The HTTP
//! adapters read `is_cancelled()` between SSE chunks — they are already awake,
//! and a chunk is never far away. The CLI adapter cannot do that: a local agent
//! can think for thirty seconds without writing a line, and a stop that is only
//! noticed on the next line is not a stop. It awaits `cancelled()` inside a
//! `select!` instead, so pressing stop kills the child process immediately.
//!
//! A `watch` channel rather than a `Notify` on purpose: `watch` retains the
//! value, so a stop that lands before the waiter registers is still seen. With
//! `notify_waiters()` that same race is a turn that never ends.

use tokio::sync::watch;

pub struct Cancel {
    tx: watch::Sender<bool>,
}

impl Default for Cancel {
    fn default() -> Self {
        Self {
            tx: watch::channel(false).0,
        }
    }
}

impl Cancel {
    pub fn trigger(&self) {
        // `send_replace` rather than `send`: the HTTP adapters never subscribe
        // — they read the value directly — and `send` reports "no receivers" as
        // an error and leaves the value untouched. That would make stop a
        // silent no-op for every provider except the CLI one.
        self.tx.send_replace(true);
    }

    pub fn is_cancelled(&self) -> bool {
        *self.tx.borrow()
    }

    /// Resolves once the turn has been stopped, and never otherwise.
    pub async fn cancelled(&self) {
        let mut rx = self.tx.subscribe();
        while !*rx.borrow_and_update() {
            if rx.changed().await.is_err() {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn starts_live_and_latches() {
        let cancel = Cancel::default();
        assert!(!cancel.is_cancelled());
        cancel.trigger();
        assert!(cancel.is_cancelled());
        // Latched, not a pulse — a second reader must still see the stop.
        assert!(cancel.is_cancelled());
    }

    /// The race the `watch` channel exists to close: stop arrives before
    /// anything is waiting on it. A `Notify` would drop that wakeup and the
    /// CLI adapter would sit in `select!` until the child exited on its own.
    #[tokio::test]
    async fn a_stop_that_lands_before_the_waiter_is_still_seen() {
        let cancel = Arc::new(Cancel::default());
        cancel.trigger();

        tokio::time::timeout(std::time::Duration::from_millis(200), cancel.cancelled())
            .await
            .expect("cancelled() should resolve for a stop that already happened");
    }

    #[tokio::test]
    async fn a_waiter_wakes_on_a_later_stop() {
        let cancel = Arc::new(Cancel::default());
        let waiter = cancel.clone();
        let task = tokio::spawn(async move { waiter.cancelled().await });

        tokio::task::yield_now().await;
        cancel.trigger();

        tokio::time::timeout(std::time::Duration::from_millis(200), task)
            .await
            .expect("waiter should wake")
            .expect("task should not panic");
    }
}
