import type { AgentEvent, AgentResult } from '@touchai/agent-core/contracts';

import type { SessionMessage } from './history';
import type {
    AgentPresentationChunk,
    AgentPresentationMessages,
    AgentPresentationTools,
} from './presentation';
import type {
    DeliveredPendingUserMessage,
    PendingUserMessage,
    StartSessionTaskOptions,
    TaskModelSummary,
    TaskViewSnapshot,
} from './task';

export interface AgentPendingDelivery {
    claimPriority(): PendingUserMessage[];
    releasePriority(messageIds: readonly string[]): void;
    isClaimCurrent(messageId: string): boolean;
    hasImmediate(): boolean;
    flush(): Promise<void>;
    delivered(messages: DeliveredPendingUserMessage[]): void;
    rejected(messageIds: string[]): void;
}

export interface PendingMessageStore {
    enqueue(sessionId: number, message: PendingUserMessage): void;
    update(sessionId: number, message: PendingUserMessage): void;
    remove(sessionId: number, messageId: string): void;
    clear(sessionId: number): void;
    reorder(sessionId: number, orderedMessageIds: readonly string[]): void;
    updateModel(sessionId: number, modelId: string | null, providerId: number | null): void;
    flush(sessionId: number): Promise<void>;
    load(sessionId: number): Promise<PendingUserMessage[]>;
}

/** Execution authority is supplied by main composition, not created by session management. */
export interface AgentSessionExecution {
    start(
        input: StartSessionTaskOptions,
        pendingDelivery?: AgentPendingDelivery
    ): { taskId: string; completion: Promise<AgentResult> };
    subscribe(taskId: string, listener: (event: AgentEvent) => void): () => void;
    cancel(taskId: string): boolean;
    reply(input: { taskId: string; decisionId: string; value: unknown }): boolean;
}

export interface AgentSessionHost {
    execution: AgentSessionExecution;
    pendingMessages?: PendingMessageStore;
    beforeStart(): Promise<void>;
    loadHistory(sessionId: number): Promise<SessionMessage[]>;
    modelSummary(taskId: string, key: string): TaskModelSummary | null;
    subscribePresentation(
        taskId: string,
        listener: (chunk: AgentPresentationChunk, attemptToken: string) => void
    ): () => void;
    messages: AgentPresentationMessages;
    tools: AgentPresentationTools;
    publishStatus?(snapshot: TaskViewSnapshot): void;
    reportObserverError?(error: unknown): void;
}
