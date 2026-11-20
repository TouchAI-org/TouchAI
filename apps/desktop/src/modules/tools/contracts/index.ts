import type { AiToolCall, AiToolDefinition } from '@touchai/models/contracts';

import type { ToolEventBuiltInConversationSemantic } from './events';
import type { ToolModelReference, ToolResultDetails, ToolTaskContext } from './host';

export type ToolSource = 'builtin' | 'mcp';
export type ToolControlIntent = 'upgrade_model' | 'activate_skill';
export type ToolSideEffect = 'none' | 'completed' | 'unknown';
export type ToolFailureCode =
    | 'tool_unavailable'
    | 'invalid_arguments'
    | 'approval_rejected'
    | 'request_cancelled'
    | 'execution_failed'
    | 'invalid_control'
    | 'skill_context_limit';

export interface ToolDeclaration extends AiToolDefinition {
    adaptiveTimeoutCeilingMs?: number;
}

export interface ToolApproval {
    title: string;
    description: string;
    command: string;
    riskLabel: string;
    reason: string;
    commandLabel: string;
    approveLabel: string;
    rejectLabel: string;
    enterHint: string;
    escHint: string;
    keyboardApproveDelayMs?: number;
}

export interface ToolInvocationScope {
    iteration: number;
    restriction?: 'skill_context_limit';
    signal?: AbortSignal;
    requestedTimeoutMs?: number;
    approvalGranted?: boolean;
    requestApproval?(callId: string, approval: ToolApproval): Promise<boolean>;
    task?: ToolTaskContext;
    callId?: string;
}

export interface ToolControlRequest {
    type: ToolControlIntent;
    targetKey: string;
    restart?: boolean;
}

export interface ToolResult extends ToolResultDetails {
    result: string;
    isError: boolean;
    persistedResult?: string;
    sideEffect?: ToolSideEffect;
    control?: ToolControlRequest;
}

export interface ToolOutcome extends ToolResult {
    sideEffect: ToolSideEffect;
    receiptKey?: string;
    failureCode?: ToolFailureCode;
    argumentParseFailed?: boolean;
    input?: string;
}

export interface PreparedTool {
    declaration: ToolDeclaration;
    authorize(scope: ToolInvocationScope): Promise<boolean>;
    approval?(
        args: Record<string, unknown>,
        scope: ToolInvocationScope
    ): Promise<ToolApproval | null>;
    describe?(
        args: Record<string, unknown>,
        scope: ToolInvocationScope
    ): Promise<ToolEventBuiltInConversationSemantic>;
    approvalRejected?(args: Record<string, unknown>, scope: ToolInvocationScope): Promise<void>;
    execute(args: Record<string, unknown>, scope: ToolInvocationScope): Promise<ToolResult>;
}

export interface ToolPreparationScope {
    taskId: string;
    currentModel: ToolModelReference;
}

export interface ToolRegistration {
    name: string;
    source: ToolSource;
    controlIntent?: ToolControlIntent;
    prepare(scope?: ToolPreparationScope): Promise<PreparedTool | null>;
}

export interface ToolSnapshot {
    readonly declarations: readonly ToolDeclaration[];
    execute(call: AiToolCall, scope: ToolInvocationScope): Promise<ToolOutcome>;
}

export interface ToolAudit {
    readonly receiptKey?: string;
    readonly input?: string;
    started?(semantic?: ToolEventBuiltInConversationSemantic): Promise<void>;
    approval?(approval: ToolApproval, approved?: boolean): Promise<void>;
    finish(outcome: ToolOutcome): Promise<void>;
}

export type McpToolRegistration = Omit<ToolRegistration, 'source' | 'controlIntent'> & {
    source: 'mcp';
    controlIntent?: never;
};

export interface McpToolCatalog {
    prepareTools(): Promise<readonly McpToolRegistration[]>;
}

export interface ToolsOptions {
    registrations: readonly ToolRegistration[];
    mcp?: McpToolCatalog;
    formatError(
        code: ToolFailureCode,
        details?: string,
        context?: {
            toolName: string;
            invalidArguments?: 'json' | 'shape' | 'schema';
            issues?: readonly { path: readonly PropertyKey[]; message: string }[];
        }
    ): string;
    beginAudit?(
        call: AiToolCall,
        input: Record<string, unknown> | string,
        scope: ToolInvocationScope
    ): Promise<ToolAudit>;
}
