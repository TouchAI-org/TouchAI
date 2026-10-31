// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 内置 Bash 执行取消注册表。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::oneshot;

const PENDING_CANCELLATION_TTL: Duration = Duration::from_secs(30);

#[derive(Default)]
struct BuiltInProcessRegistryState {
    current_registrations: HashMap<String, ProcessRegistration>,
    next_registration: u64,
    pending_cancellations: HashMap<String, Instant>,
}

struct ProcessRegistration {
    id: u64,
    sender: Option<oneshot::Sender<()>>,
}

/// 维护"执行 ID -> 取消信号发送端"的映射。
///
/// 前端通过 execution_id 发起取消命令时，
/// 原生层不直接持有子进程句柄，而是向正在等待中的执行任务发送一个取消信号，
/// 由执行任务自己负责终止并回收子进程。
#[derive(Clone, Default)]
pub struct BuiltInProcessExecutionRegistry {
    state: Arc<Mutex<BuiltInProcessRegistryState>>,
}

pub type BashExecutionRegistry = BuiltInProcessExecutionRegistry;

impl BuiltInProcessExecutionRegistry {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(BuiltInProcessRegistryState::default())),
        }
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn register(&self, execution_id: String) -> (oneshot::Receiver<()>, u64) {
        let (sender, receiver) = oneshot::channel();
        let mut state = self
            .state
            .lock()
            .expect("BuiltInProcessExecutionRegistry poisoned");
        prune_expired_pending_cancellations(&mut state);
        let registration = state.next_registration;
        state.next_registration = state.next_registration.wrapping_add(1);
        // 取消命令可能比实际执行注册更早到达。
        // 如果 execution_id 已被提前标记为待取消，则在注册瞬间立刻把取消信号打给本次执行，
        // 从而覆盖 IPC/线程调度乱序造成的"先取消、后注册"竞态。
        let current_sender = if state.pending_cancellations.remove(&execution_id).is_some() {
            let _ = sender.send(());
            None
        } else {
            Some(sender)
        };

        // execution_id 理论上应唯一；若前端重复使用旧 ID，
        // 直接让旧执行收到取消信号，避免注册表里留下悬空项。
        if let Some(previous) = state.current_registrations.insert(
            execution_id,
            ProcessRegistration {
                id: registration,
                sender: current_sender,
            },
        ) {
            if let Some(previous_sender) = previous.sender {
                let _ = previous_sender.send(());
            }
        }

        (receiver, registration)
    }

    /// 向指定 execution_id 发送取消信号。
    ///
    /// 返回 `true` 表示该执行正在进行中，已立即发送取消信号；
    /// 返回 `false` 表示未找到活跃执行，已记录为待取消（覆盖先取消后注册的竞态）。
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn cancel(&self, execution_id: &str) -> bool {
        let mut state = self
            .state
            .lock()
            .expect("BuiltInProcessExecutionRegistry poisoned");
        prune_expired_pending_cancellations(&mut state);

        if let Some(sender) = state
            .current_registrations
            .get_mut(execution_id)
            .and_then(|registration| registration.sender.take())
        {
            let _ = sender.send(());
            return true;
        }

        state
            .pending_cancellations
            .insert(execution_id.to_string(), Instant::now());
        false
    }

    pub fn cancel_all(&self) -> usize {
        let senders = {
            let mut state = self
                .state
                .lock()
                .expect("BuiltInProcessExecutionRegistry poisoned");
            prune_expired_pending_cancellations(&mut state);
            state.pending_cancellations.clear();
            state
                .current_registrations
                .values_mut()
                .filter_map(|registration| registration.sender.take())
                .collect::<Vec<_>>()
        };

        let count = senders.len();
        for sender in senders {
            let _ = sender.send(());
        }

        count
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn complete(&self, execution_id: &str, registration: u64) {
        let mut state = self
            .state
            .lock()
            .expect("BuiltInProcessExecutionRegistry poisoned");
        prune_expired_pending_cancellations(&mut state);
        if state
            .current_registrations
            .get(execution_id)
            .is_some_and(|current| current.id == registration)
        {
            state.current_registrations.remove(execution_id);
            state.pending_cancellations.remove(execution_id);
        }
    }
}

fn prune_expired_pending_cancellations(state: &mut BuiltInProcessRegistryState) {
    let now = Instant::now();
    state
        .pending_cancellations
        .retain(|_, created_at| now.duration_since(*created_at) <= PENDING_CANCELLATION_TTL);
}

#[cfg(test)]
mod tests {
    use tokio::sync::oneshot::error::TryRecvError;

    use super::BuiltInProcessExecutionRegistry;

    #[test]
    fn user_cancelling_all_signals_every_registered_execution() {
        let registry = BuiltInProcessExecutionRegistry::new();
        let (mut first, _) = registry.register("first".to_string());
        let (mut second, _) = registry.register("second".to_string());

        assert_eq!(registry.cancel_all(), 2);
        assert!(first.try_recv().is_ok());
        assert!(second.try_recv().is_ok());
        assert_eq!(registry.cancel_all(), 0);
    }
    #[test]
    fn user_gets_a_cancel_already_waiting_when_it_arrives_before_the_execution_starts() {
        let registry = BuiltInProcessExecutionRegistry::new();

        // The cancel IPC may overtake the execution registration; the signal must not be lost.
        assert!(!registry.cancel("late-start"));
        let (mut receiver, _) = registry.register("late-start".to_string());

        assert!(receiver.try_recv().is_ok());
    }

    #[test]
    fn user_cancelling_a_running_execution_reports_it_as_found() {
        let registry = BuiltInProcessExecutionRegistry::new();
        let (mut receiver, _) = registry.register("running".to_string());

        assert!(registry.cancel("running"));
        assert!(receiver.try_recv().is_ok());
        // A second cancel finds nothing left to signal.
        assert!(!registry.cancel("running"));
    }

    #[test]
    fn user_reusing_an_execution_id_cancels_the_older_execution() {
        let registry = BuiltInProcessExecutionRegistry::new();
        let (mut first, _) = registry.register("same-id".to_string());

        let (mut second, _) = registry.register("same-id".to_string());

        // The stale execution is signalled so it cannot keep running unnoticed.
        assert!(first.try_recv().is_ok());
        assert!(matches!(second.try_recv(), Err(TryRecvError::Empty)));
    }

    #[test]
    fn user_can_cancel_newer_execution_after_older_same_id_completes() {
        let registry = BuiltInProcessExecutionRegistry::new();
        let (mut older, older_registration) = registry.register("same-id".to_string());
        let (mut newer, newer_registration) = registry.register("same-id".to_string());

        assert!(older.try_recv().is_ok());
        registry.complete("same-id", older_registration);

        assert!(registry.cancel("same-id"));
        assert!(newer.try_recv().is_ok());
        registry.complete("same-id", newer_registration);
    }

    #[test]
    fn user_keeps_pending_cancellation_when_stale_execution_completes() {
        let registry = BuiltInProcessExecutionRegistry::new();
        let (mut older, older_registration) = registry.register("same-id".to_string());
        let (mut newer, _) = registry.register("same-id".to_string());

        assert!(older.try_recv().is_ok());
        assert!(registry.cancel("same-id"));
        assert!(newer.try_recv().is_ok());
        assert!(!registry.cancel("same-id"));

        registry.complete("same-id", older_registration);
        let (mut next, _) = registry.register("same-id".to_string());
        assert!(next.try_recv().is_ok());
    }

    #[test]
    fn user_gets_a_completed_execution_removed_from_the_registry() {
        let registry = BuiltInProcessExecutionRegistry::new();
        let (_receiver, registration) = registry.register("done".to_string());

        registry.complete("done", registration);

        // Nothing is left to cancel, so the cancel is recorded as pending instead.
        assert!(!registry.cancel("done"));
        assert_eq!(registry.cancel_all(), 0);
    }

    #[test]
    fn user_completing_an_unknown_execution_is_harmless() {
        let registry = BuiltInProcessExecutionRegistry::new();

        registry.complete("never-registered", 0);

        assert_eq!(registry.cancel_all(), 0);
    }

    #[test]
    fn user_cancelling_everything_also_clears_pending_cancellations() {
        let registry = BuiltInProcessExecutionRegistry::new();
        registry.cancel("pending-only");

        assert_eq!(registry.cancel_all(), 0);

        // The pending marker was cleared, so registering now starts a clean execution.
        let (mut receiver, _) = registry.register("pending-only".to_string());
        assert!(matches!(receiver.try_recv(), Err(TryRecvError::Empty)));
    }
    #[test]
    fn user_completing_an_execution_also_drops_a_cancel_that_was_waiting_for_it() {
        let registry = BuiltInProcessExecutionRegistry::new();

        let (_old_receiver, registration) = registry.register("raced".to_string());
        assert!(registry.cancel("raced"));
        assert!(!registry.cancel("raced"));
        registry.complete("raced", registration);

        // The stale marker must not cancel the next execution that reuses the id.
        let (mut receiver, _) = registry.register("raced".to_string());
        assert!(matches!(receiver.try_recv(), Err(TryRecvError::Empty)));
    }
}
