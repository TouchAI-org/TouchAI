import type {
    AiMessage,
    AiRequestOptions,
    AiStreamChunk,
    AiTiming,
    AiUsage,
    JsonObject,
} from '@touchai/models/contracts';

import type { AgentTools, DecisionAnswer, DecisionQuestion } from './tool';

export interface AgentModel {
    key: string;
    connectionKey: string;
    model: string;
    contextLimit: number | null;
    outputLimit: number | null;
    supportsReasoning: boolean;
    supportsTools: boolean;
    reasoningOptions?: AiRequestOptions['reasoningOptions'];
    preserveReasoningCache?: boolean;
}

export interface MessageOrigin {
    key: string;
    order: number;
    fingerprint: string;
}

export interface ContextSummary {
    id: string;
    text: string;
    firstKeptMessageKey: string;
    systemMessageKeys: string[];
}

export interface ContextSummaryRecord extends ContextSummary {
    model: string;
    connectionKey: string;
    createdAt: number;
    tokensBefore: number;
    tokensAfter: number;
}

export interface ContextSummarySource {
    messages: MessageOrigin[];
    previous?: ContextSummary;
}

export interface AgentMessage extends AiMessage {
    origin?: MessageOrigin;
    summary?: ContextSummary;
    summaryPartKey?: string;
}

export interface OutputPart {
    type: 'text' | 'reasoning';
    content: string;
    startedAt?: number;
    endedAt?: number;
    providerOptions?: Record<string, JsonObject>;
}

export interface AgentCall {
    iteration: number;
    modelKey: string;
    connectionKey: string;
    model: string;
    usage: AiUsage;
    usageReported: boolean;
    timing: AiTiming;
    finishReason?: string;
    toolCallsInStep: number;
    toolArgumentErrors: number;
}

export interface AgentCheckpoint {
    modelKey: string;
    messages: AgentMessage[];
    response: string;
    reasoning: string;
    iteration: number;
    modelSwitchCount: number;
    outputParts: OutputPart[];
}

export interface AgentStartInput {
    prompt: string;
    conversationKey?: string;
    modelKey?: string;
    requestKey?: string;
    mode?: 'foreground' | 'background';
    signal?: AbortSignal;
}

export interface AgentPreparedTurn {
    model: AgentModel;
    messages: AgentMessage[];
    tools: AgentTools;
    stream(request: AiRequestOptions, scope: AgentScope): AsyncIterable<AiStreamChunk>;
    release(): Promise<void> | void;
    recovery?: AgentCheckpoint;
    promptFragments?: PromptFragment[];
    pendingMessages?: {
        hasImmediate(): boolean;
        deliver(scope: AgentScope): Promise<{
            messages: AgentMessage[];
            privateContents?: Array<{ index: number; content: AiMessage['content'] }>;
        }>;
    };
}

export type PromptSource =
    | 'override'
    | 'platform'
    | 'policy'
    | 'agent_profile'
    | 'session_memory'
    | 'mode'
    | 'feature'
    | 'skill'
    | 'user_append';

export interface PromptFragment {
    id?: string;
    source: PromptSource;
    content: string;
}

export interface AgentScope {
    taskId: string;
    attemptToken: string;
    attemptGeneration: number;
    iteration: number;
    signal: AbortSignal;
}

export type AgentStatus =
    | 'running'
    | 'waiting_approval'
    | 'waiting_question'
    | 'completed'
    | 'failed'
    | 'cancelled';

export interface AgentView {
    taskId: string;
    conversationKey: string | null;
    turnKey: string | null;
    modelKey: string | null;
    status: AgentStatus;
    attempt: number;
    errorCode: string | null;
}

export interface AgentResult {
    modelKey: string;
    turnKey: string | null;
    response: string;
    reasoning: string;
    usage: AiUsage;
    calls: AgentCall[];
}

export interface AgentTerminal {
    status: 'completed' | 'failed' | 'cancelled';
    errorCode?: string;
    errorMessage?: string;
    outputParts: OutputPart[];
    calls: AgentCall[];
    usage: AiUsage;
    durationMs: number;
    modelSwitchCount: number;
    toolArgumentErrors: number;
    hitModelSwitchCeiling: boolean;
}

export type AgentEvent =
    | {
          type: 'task_started';
          taskId: string;
          conversationKey: string | null;
          turnKey: string | null;
          modelKey: string;
      }
    | { type: 'attempt_started'; taskId: string; attemptToken: string; attempt: number }
    | { type: 'attempt_finished'; taskId: string; attemptToken: string }
    | {
          type: 'stream';
          taskId: string;
          attemptToken: string;
          iteration: number;
          chunk: AiStreamChunk;
      }
    | {
          type: 'decision_required';
          taskId: string;
          decisionId: string;
          callId: string;
          kind: 'approval';
          payload: JsonObject;
      }
    | {
          type: 'decision_required';
          taskId: string;
          decisionId: string;
          callId: string;
          kind: 'question';
          payload: DecisionQuestion[];
      }
    | {
          type: 'decision_resolved';
          taskId: string;
          decisionId: string;
          callId: string;
          kind: 'approval' | 'question';
          value: boolean | DecisionAnswer[] | null;
      }
    | { type: 'checkpoint_committed'; taskId: string; checkpoint: AgentCheckpoint }
    | {
          type: 'retry_scheduled';
          taskId: string;
          attempt: number;
          checkpoint: AgentCheckpoint;
          errorCode: string;
          discardOutput: boolean;
          discardToolActivity: boolean;
      }
    | { type: 'iteration_start' | 'iteration_end'; taskId: string; iteration: number }
    | {
          type: 'model_switched';
          taskId: string;
          fromModelKey: string;
          modelKey: string;
          restart: boolean;
      }
    | {
          type: 'context_compaction';
          taskId: string;
          id: string;
          state: 'compacting' | 'compacted' | 'failed';
      }
    | { type: 'persistence_issue'; taskId: string; phase: 'progress' | 'cleanup' }
    | { type: 'task_completed'; taskId: string; result: AgentResult }
    | { type: 'task_failed' | 'task_cancelled'; taskId: string; errorCode: string };

export class AgentError extends Error {
    constructor(
        readonly code: string,
        readonly retryable = false,
        options?: ErrorOptions
    ) {
        super(code, options);
        this.name = 'AgentError';
    }
}
