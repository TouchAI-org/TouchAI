import type { AiToolCall } from '@touchai/models/contracts';

import type {
    AgentCall,
    AgentCheckpoint,
    AgentMessage,
    AgentModel,
    AgentPreparedTurn,
    AgentScope,
    AgentStartInput,
    AgentTerminal,
    ContextSummaryRecord,
    ContextSummarySource,
    MessageOrigin,
    OutputPart,
} from './agent';
import type { AgentToolOutcome } from './tool';

export interface ProgressTarget extends AgentScope {
    step: number;
    revision: number;
}

export interface AgentPersistence {
    start(
        checkpoint: AgentCheckpoint,
        scope: AgentScope
    ): Promise<{
        conversationKey?: string;
        turnKey?: string;
        currentUserOrigin?: MessageOrigin;
    }>;
    progress(parts: OutputPart[], target: ProgressTarget): Promise<void>;
    assistant?(parts: OutputPart[], scope: AgentScope): Promise<MessageOrigin | undefined>;
    toolCalls(
        step: { parts: OutputPart[]; calls: AiToolCall[]; call: AgentCall },
        scope: AgentScope
    ): Promise<string>;
    toolResult(result: AgentToolOutcome, scope: AgentScope & { messageKey: string }): Promise<void>;
    toolRoundSource(
        messageKey: string,
        parts: OutputPart[],
        results: AgentToolOutcome[]
    ): Promise<MessageOrigin | undefined>;
    checkpoint(checkpoint: AgentCheckpoint, scope: AgentScope): Promise<void>;
    retry(
        failure: { errorCode: string; checkpoint: AgentCheckpoint; terminal: AgentTerminal },
        scope: AgentScope
    ): Promise<void>;
    finish(terminal: AgentTerminal, scope: AgentScope): Promise<void>;
    validateSummary(message: AgentMessage, scope: AgentScope): Promise<void>;
    saveSummary(
        summary: ContextSummaryRecord,
        source: ContextSummarySource,
        calls: AgentCall[],
        scope: AgentScope
    ): Promise<string>;
}

export interface AgentHost {
    prepareTurn(
        input: AgentStartInput,
        scope: {
            taskId: string;
            signal: AbortSignal;
            previousModelKey?: string;
            modelSwitchCount: number;
        }
    ): Promise<AgentPreparedTurn>;
    persistence(input: AgentStartInput & { taskId: string }, model: AgentModel): AgentPersistence;
}
