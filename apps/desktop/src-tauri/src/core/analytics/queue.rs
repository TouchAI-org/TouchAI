// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Bounded, best-effort in-memory delivery queue.
//!
//! The queue intentionally does not survive a process restart. Consent and
//! installation identity remain in the existing `settings` table, while events
//! are held only for the lifetime of this process.

use std::collections::{HashMap, HashSet, VecDeque};

pub(crate) const MAX_EVENTS: i64 = 1_000;
pub(crate) const MAX_BYTES: i64 = 16 * 1024 * 1024;
pub(crate) const MAX_PAYLOAD_BYTES: i64 = 2_048;
pub(crate) const TTL_MS: i64 = 72 * 60 * 60 * 1000;
pub(crate) const SEND_BATCH_LIMIT: usize = 10;

#[derive(Debug, Clone)]
pub(crate) struct QueuedEvent {
    pub(crate) event_id: String,
    pub(crate) consent_epoch: i64,
    pub(crate) event_name: String,
    pub(crate) payload_json: String,
    pub(crate) payload_bytes: i64,
    pub(crate) enqueued_at: i64,
    pub(crate) expires_at: i64,
    pub(crate) next_attempt_at: i64,
    pub(crate) attempt_count: i64,
    pub(crate) priority: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct QueueInsert {
    pub(crate) event_id: String,
    pub(crate) consent_epoch: i64,
    pub(crate) event_name: String,
    pub(crate) payload_json: String,
    pub(crate) priority: i64,
    pub(crate) marks_first_success: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum EnqueueOutcome {
    Queued,
    Unavailable,
    Rejected,
}

#[derive(Default)]
pub(crate) struct AnalyticsQueue {
    entries: VecDeque<QueuedEvent>,
    bytes: i64,
}

impl AnalyticsQueue {
    /// Offers a batch without evicting already accepted events. This mirrors the
    /// Cherry Studio SDK's "newest events drop on overflow" behavior.
    pub(crate) fn enqueue_batch(
        &mut self,
        inserts: Vec<QueueInsert>,
        now: i64,
    ) -> (EnqueueOutcome, bool) {
        if inserts.is_empty() {
            return (EnqueueOutcome::Queued, false);
        }
        let mut incoming_bytes = 0_i64;
        for insert in &inserts {
            let payload_bytes = insert.payload_json.len() as i64;
            if payload_bytes <= 0 || payload_bytes > MAX_PAYLOAD_BYTES {
                return (EnqueueOutcome::Rejected, false);
            }
            incoming_bytes += payload_bytes;
        }
        if self.entries.len() as i64 + inserts.len() as i64 > MAX_EVENTS
            || self.bytes + incoming_bytes > MAX_BYTES
        {
            return (EnqueueOutcome::Unavailable, false);
        }

        let mut marks_first_success = false;
        for insert in inserts {
            let payload_bytes = insert.payload_json.len() as i64;
            self.bytes += payload_bytes;
            marks_first_success |= insert.marks_first_success;
            self.entries.push_back(QueuedEvent {
                event_id: insert.event_id,
                consent_epoch: insert.consent_epoch,
                event_name: insert.event_name,
                payload_json: insert.payload_json,
                payload_bytes,
                enqueued_at: now,
                expires_at: now + TTL_MS,
                next_attempt_at: now,
                attempt_count: 0,
                priority: insert.priority,
            });
        }
        (EnqueueOutcome::Queued, marks_first_success)
    }

    pub(crate) fn due_batch(&self, now: i64, limit: usize) -> Vec<QueuedEvent> {
        let mut due: Vec<QueuedEvent> = self
            .entries
            .iter()
            .filter(|event| event.next_attempt_at <= now && event.expires_at > now)
            .cloned()
            .collect();
        due.sort_by_key(|event| {
            (
                if event.event_name == "analytics.session_started" {
                    0
                } else {
                    event.priority
                },
                event.next_attempt_at,
                event.enqueued_at,
            )
        });
        due.truncate(limit);
        due
    }

    pub(crate) fn contains(&self, event_id: &str, consent_epoch: i64, now: i64) -> bool {
        self.entries.iter().any(|event| {
            event.event_id == event_id
                && event.consent_epoch == consent_epoch
                && event.expires_at > now
        })
    }

    pub(crate) fn remove(&mut self, event_id: &str) {
        if let Some(index) = self
            .entries
            .iter()
            .position(|event| event.event_id == event_id)
        {
            if let Some(event) = self.entries.remove(index) {
                self.bytes = (self.bytes - event.payload_bytes).max(0);
            }
        }
    }

    pub(crate) fn reschedule(&mut self, event_id: &str, next_attempt_at: i64) {
        if let Some(event) = self
            .entries
            .iter_mut()
            .find(|event| event.event_id == event_id)
        {
            event.next_attempt_at = next_attempt_at;
            event.attempt_count = event.attempt_count.saturating_add(1);
        }
    }

    pub(crate) fn hold_until(&mut self, event_id: &str, next_attempt_at: i64) {
        if let Some(event) = self
            .entries
            .iter_mut()
            .find(|event| event.event_id == event_id)
        {
            event.next_attempt_at = event.next_attempt_at.max(next_attempt_at);
        }
    }

    pub(crate) fn stats(&self) -> (i64, i64) {
        (self.entries.len() as i64, self.bytes)
    }

    pub(crate) fn pending_session_starts(&self) -> HashMap<String, i64> {
        self.entries
            .iter()
            .filter(|event| event.event_name == "analytics.session_started")
            .filter_map(|event| {
                session_id_from_payload(&event.payload_json)
                    .map(|session_id| (session_id, event.next_attempt_at))
            })
            .collect()
    }

    pub(crate) fn drop_session(&mut self, session_id: &str) -> u64 {
        let before = self.entries.len();
        self.entries.retain(|event| {
            session_id_from_payload(&event.payload_json).as_deref() != Some(session_id)
        });
        self.recalculate_bytes();
        (before - self.entries.len()) as u64
    }

    pub(crate) fn purge_expired(&mut self, now: i64) -> Vec<Option<String>> {
        let expired_sessions: HashSet<Option<String>> = self
            .entries
            .iter()
            .filter(|event| {
                event.expires_at <= now && event.event_name == "analytics.session_started"
            })
            .map(|event| session_id_from_payload(&event.payload_json))
            .collect();
        let expired_sessions_vec: Vec<Option<String>> = expired_sessions.iter().cloned().collect();
        self.entries.retain(|event| {
            if event.expires_at <= now {
                return false;
            }
            match session_id_from_payload(&event.payload_json) {
                // A session start that expired makes every event in that session
                // undeliverable, even if the dependent's own TTL is longer.
                Some(session_id) => !expired_sessions.contains(&Some(session_id)),
                // A corrupt session start cannot prove any handle-less event is
                // independent, so preserve the prior fail-closed behavior.
                None => !expired_sessions.contains(&None),
            }
        });
        self.recalculate_bytes();
        expired_sessions_vec
    }

    pub(crate) fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
    }

    #[cfg(test)]
    pub(crate) fn events_for_tests(&self) -> Vec<QueuedEvent> {
        self.entries.iter().cloned().collect()
    }

    #[cfg(test)]
    pub(crate) fn set_next_attempt_for_event_name(&mut self, event_name: &str, next: i64) {
        for event in &mut self.entries {
            if event.event_name == event_name {
                event.next_attempt_at = next;
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn set_all_next_attempts(&mut self, next: i64) {
        for event in &mut self.entries {
            event.next_attempt_at = next;
        }
    }

    #[cfg(test)]
    pub(crate) fn expire_session_starts(&mut self) {
        for event in &mut self.entries {
            if event.event_name == "analytics.session_started" {
                event.expires_at = 0;
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn corrupt_session_start_for_tests(&mut self) {
        for event in &mut self.entries {
            if event.event_name == "analytics.session_started" {
                event.payload_json = r#"{"not":"an envelope"}"#.to_string();
            }
        }
    }

    fn recalculate_bytes(&mut self) {
        self.bytes = self.entries.iter().map(|event| event.payload_bytes).sum();
    }
}

pub(crate) fn session_id_from_payload(payload_json: &str) -> Option<String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SessionRef {
        #[serde(default)]
        analytics_session_id: Option<String>,
    }
    serde_json::from_str::<SessionRef>(payload_json)
        .ok()?
        .analytics_session_id
}

#[cfg(test)]
mod tests {
    use super::*;

    fn insert(id: &str, event_name: &str, payload: &str) -> QueueInsert {
        QueueInsert {
            event_id: id.to_string(),
            consent_epoch: 1,
            event_name: event_name.to_string(),
            payload_json: payload.to_string(),
            priority: if event_name == "analytics.session_started" {
                0
            } else {
                100
            },
            marks_first_success: false,
        }
    }

    #[test]
    fn user_gets_new_events_dropped_when_the_memory_queue_is_full() {
        let mut queue = AnalyticsQueue::default();
        for index in 0..MAX_EVENTS {
            let id = format!("e{index}");
            queue.enqueue_batch(vec![insert(&id, "app.started", "{}")], 1);
        }
        let (outcome, _) = queue.enqueue_batch(vec![insert("new", "app.started", "{}")], 1);
        assert_eq!(outcome, EnqueueOutcome::Unavailable);
        assert_eq!(queue.stats().0, MAX_EVENTS);
    }

    #[test]
    fn user_gets_session_start_ordered_before_its_dependents() {
        let mut queue = AnalyticsQueue::default();
        queue.enqueue_batch(
            vec![
                insert(
                    "session",
                    "analytics.session_started",
                    r#"{"analyticsSessionId":"s1"}"#,
                ),
                insert(
                    "event",
                    "agent.request_submitted",
                    r#"{"analyticsSessionId":"s1"}"#,
                ),
            ],
            1,
        );
        let due = queue.due_batch(1, 10);
        assert_eq!(due[0].event_id, "session");
        assert_eq!(due[1].event_id, "event");
    }

    #[test]
    fn user_gets_all_events_for_a_rejected_session_dropped_together() {
        let mut queue = AnalyticsQueue::default();
        queue.enqueue_batch(
            vec![
                insert(
                    "session",
                    "analytics.session_started",
                    r#"{"analyticsSessionId":"s1"}"#,
                ),
                insert(
                    "event",
                    "agent.request_submitted",
                    r#"{"analyticsSessionId":"s1"}"#,
                ),
            ],
            1,
        );
        assert_eq!(queue.drop_session("s1"), 2);
        assert!(queue.stats().0 == 0);
    }

    #[test]
    fn user_gets_expired_events_removed_without_an_expired_session_start() {
        let mut queue = AnalyticsQueue::default();
        queue.enqueue_batch(
            vec![insert("standalone", "analytics.health_reported", "{}")],
            1,
        );
        queue.entries[0].expires_at = 2;

        assert!(queue.purge_expired(2).is_empty());
        assert_eq!(queue.stats(), (0, 0));
    }
}
