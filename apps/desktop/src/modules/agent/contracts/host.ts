import type { AgentEvent, AgentResult } from '@touchai/agent-core/contracts';

import type { SessionMessage } from './history';
import type {
    AgentPresentationChunk,
    AgentPresentationMessages,
    AgentPresentationTools,
} from './presentation';
import type { StartSessionTaskOptions, TaskModelSummary, TaskViewSnapshot } from './task';

/** Execution authority is supplied by main composition, not created by session management. */
export interface AgentSessionExecution {
    start(input: StartSessionTaskOptions): { taskId: string; completion: Promise<AgentResult> };
    subscribe(taskId: string, listener: (event: AgentEvent) => void): () => void;
    cancel(taskId: string): boolean;
    reply(input: { taskId: string; decisionId: string; value: unknown }): boolean;
}

export interface AgentSessionHost {
    execution: AgentSessionExecution;
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
