import type {
    AiMessage,
    AiToolCall,
    AiToolDefinition,
    JsonObject,
} from '@touchai/models/contracts';

import type { AgentScope } from './agent';

export interface DecisionQuestion {
    question: string;
    header?: string;
    multiSelect?: boolean;
    allowOther?: boolean;
    options: { label: string; description?: string }[];
}

export interface DecisionAnswer {
    questionIndex: number;
    selectedLabels: string[];
    otherText?: string;
    skipped: boolean;
}

export interface AgentToolScope extends AgentScope {
    taskSignal: AbortSignal;
    cancelTask(): void;
    messageKey: string | null;
    restriction?: 'skill_context_limit';
    approve(callId: string, payload: JsonObject): Promise<boolean>;
    ask(callId: string, questions: DecisionQuestion[]): Promise<DecisionAnswer[] | null>;
}

export interface AgentToolResult {
    result: string;
    isError: boolean;
    sideEffect: 'none' | 'completed' | 'unknown';
    persistedResult?: string;
    content?: AiMessage['content'];
    persistedContent?: AiMessage['content'];
    receiptKey?: string;
    control?: { type: 'upgrade_model' | 'activate_skill'; targetKey: string; restart?: boolean };
    argumentParseFailed?: boolean;
}

export interface AgentToolOutcome extends AgentToolResult {
    call: AiToolCall;
    input?: string;
}

export interface AgentTools {
    readonly declarations: readonly AiToolDefinition[];
    execute(call: AiToolCall, scope: AgentToolScope): Promise<AgentToolResult>;
}
