// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 展示快照构建。
 *
 * 订阅者与任务中心同处一个 JS 上下文，因此流式发布的主要成本不是序列化，
 * 而是**全量深拷贝整段会话历史**与随后的重渲染。这里在发布边界做结构共享：
 *
 * - 与上次发布内容完全相同的消息，直接复用上次发布的对象引用；
 * - 只有真正变化的消息才深拷贝；
 * - 小对象（待审批、模型等）继续深拷贝，保证订阅者与投影后续就地修改相互隔离。
 *
 * 消费者按「只读」使用发布结果：不要修改快照里的对象。
 */

import type { SessionMessage } from '@/types/session';

import type { SessionTaskSnapshot, SessionTaskViewSnapshot } from './types';
import { cloneTaskValue } from './types';

/**
 * 结构化深比较。
 *
 * 基本类型按值比较（字符串因此是 O(n) memcmp，但不会产生分配）；
 * 对象/数组按字段递归比较，`Object.is` 相同引用直接短路。
 */
function isDeepEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) {
        return true;
    }

    if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
        return left === right;
    }

    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
            return false;
        }
        return left.every((item, index) => isDeepEqual(item, right[index]));
    }

    const leftKeys = Object.keys(left as Record<string, unknown>);
    const rightKeys = Object.keys(right as Record<string, unknown>);
    if (leftKeys.length !== rightKeys.length) {
        return false;
    }

    return leftKeys.every((key) =>
        isDeepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key])
    );
}

/** 判断两条展示消息是否完全一致（用于复用上次发布的对象引用）。 */
export function isSameSessionMessage(left: SessionMessage, right: SessionMessage): boolean {
    return isDeepEqual(left, right);
}

/**
 * 与上次发布的会话历史做结构共享。
 *
 * 按消息 id 匹配：完全一致时复用已发布对象，发生变化时深拷贝。
 * 新消息、顺序变化、删除都在此天然覆盖。
 */
function shareUnchangedMessages(
    liveMessages: SessionMessage[],
    previousMessages: SessionMessage[]
): SessionMessage[] {
    if (previousMessages.length === 0) {
        return liveMessages.map((message) => cloneTaskValue(message) as SessionMessage);
    }

    const previousById = new Map(previousMessages.map((message) => [message.id, message]));
    return liveMessages.map((message) => {
        const published = previousById.get(message.id);
        if (published && isSameSessionMessage(message, published)) {
            return published;
        }

        return cloneTaskValue(message) as SessionMessage;
    });
}

/**
 * 构建发布给 UI 的展示快照。
 *
 * runtime checkpoint 与 prompt 快照不参与展示；传入上次发布结果时，
 * 未变化的消息沿用其对象引用，避免每帧重建整段历史。
 */
export function cloneTaskViewSnapshot(
    snapshot: SessionTaskSnapshot,
    previous: SessionTaskViewSnapshot | null = null
): SessionTaskViewSnapshot {
    return {
        taskId: snapshot.taskId,
        sessionId: snapshot.sessionId,
        turnId: snapshot.turnId,
        status: snapshot.status,
        executionMode: snapshot.executionMode,
        prompt: snapshot.prompt,
        sessionHistory: shareUnchangedMessages(
            snapshot.sessionHistory,
            previous?.sessionHistory ?? []
        ),
        pendingToolApproval: cloneTaskValue(snapshot.pendingToolApproval),
        pendingApprovals: cloneTaskValue(snapshot.pendingApprovals),
        pendingUserQuestion: cloneTaskValue(snapshot.pendingUserQuestion),
        error: snapshot.error,
        currentModel: cloneTaskValue(snapshot.currentModel),
        startedAt: snapshot.startedAt,
        updatedAt: snapshot.updatedAt,
        modelSwitchCount: snapshot.modelSwitchCount,
    };
}
