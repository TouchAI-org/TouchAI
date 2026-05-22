// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 内置 Bash 执行取消注册表。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tokio::sync::oneshot;

const PENDING_CANCELLATION_TTL: Duration = Duration::from_secs(30);

#[derive(Default)]
struct BuiltInProcessRegistryState {
    senders: HashMap<String, oneshot::Sender<()>>,
    pending_cancellations: HashMap<String, Instant>,
}

/// 维护"执行 ID -> 取消信号发送端"的映射。
///
/// 前端通过 execution_id 发起取消命令时，
/// 原生层不直接持有子进程句柄，而是向正在等待中的执行任务发送一个取消信号，
/// 由执行任务自己负责终止并回收子进程。
#[derive(Default)]
pub struct BuiltInProcessExecutionRegistry {
    state: Mutex<BuiltInProcessRegistryState>,
}

pub type BashExecutionRegistry = BuiltInProcessExecutionRegistry;

impl BuiltInProcessExecutionRegistry {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(BuiltInProcessRegistryState::default()),
        }
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn register(&self, execution_id: String) -> oneshot::Receiver<()> {
        let (sender, receiver) = oneshot::channel();
        let mut state = self
            .state
            .lock()
            .expect("BuiltInProcessExecutionRegistry poisoned");
        prune_expired_pending_cancellations(&mut state);

        // 取消命令可能比实际执行注册更早到达。
        // 如果 execution_id 已被提前标记为待取消，则在注册瞬间立刻把取消信号打给本次执行，
        // 从而覆盖 IPC/线程调度乱序造成的"先取消、后注册"竞态。
        if state.pending_cancellations.remove(&execution_id).is_some() {
            let _ = sender.send(());
            return receiver;
        }

        // execution_id 理论上应唯一；若前端重复使用旧 ID，
        // 直接让旧执行收到取消信号，避免注册表里留下悬空项。
        if let Some(previous_sender) = state.senders.insert(execution_id, sender) {
            let _ = previous_sender.send(());
        }

        receiver
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

        if let Some(sender) = state.senders.remove(execution_id) {
            let _ = sender.send(());
            return true;
        }

        state
            .pending_cancellations
            .insert(execution_id.to_string(), Instant::now());
        false
    }

    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    pub fn complete(&self, execution_id: &str) {
        let mut state = self
            .state
            .lock()
            .expect("BuiltInProcessExecutionRegistry poisoned");
        prune_expired_pending_cancellations(&mut state);
        state.senders.remove(execution_id);
        state.pending_cancellations.remove(execution_id);
    }
}

fn prune_expired_pending_cancellations(state: &mut BuiltInProcessRegistryState) {
    let now = Instant::now();
    state
        .pending_cancellations
        .retain(|_, created_at| now.duration_since(*created_at) <= PENDING_CANCELLATION_TTL);
}
