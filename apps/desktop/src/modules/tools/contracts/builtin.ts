import type {
    AskUserAnswer,
    AskUserQuestion,
    ToolEvent,
    ToolEventBuiltInConversationSemantic,
    ToolEventBuiltInConversationSemanticAction,
    ToolEventStructuredPayload,
} from './events';
import type { ToolAttachment, ToolModelReference } from './host';
import type {
    ToolApproval,
    ToolDeclaration,
    ToolInvocationScope,
    ToolPreparationScope,
} from './index';

export type BuiltInToolId =
    | 'activate_skill'
    | 'bash'
    | 'file_search'
    | 'search_conversation'
    | 'read_conversation'
    | 'read'
    | 'setting'
    | 'web_search'
    | 'web_fetch'
    | 'upgrade_model'
    | 'show_widget'
    | 'visualize_read_me'
    | 'ask_user_question'
    | 'browser'
    | 'browser_session'
    | 'browser_observe'
    | 'browser_act'
    | 'computer_use';

export interface BaseBuiltInToolExecutionContext {
    signal?: AbortSignal;
    taskSignal?: AbortSignal;
    stopTask?(): void;
    currentModel?: ToolModelReference;
    callId: string;
    iteration: number;
    emitToolEvent?(event: ToolEvent): void;
    requestUserQuestions?(
        callId: string,
        questions: AskUserQuestion[]
    ): Promise<AskUserAnswer[] | null>;
    approvalGranted?: boolean;
    requestedTimeoutMs?: number;
}

export interface UpgradeModelControlSignal {
    type: 'upgrade_model';
    targetModel: ToolModelReference;
    restartCurrentRequest: boolean;
}

export interface ActivateSkillControlSignal {
    type: 'activate_skill';
    targetKey: string;
}

export type BuiltInToolControlSignal = UpgradeModelControlSignal | ActivateSkillControlSignal;

export interface BuiltInToolExecutionResult {
    result: string;
    isError: boolean;
    status: 'success' | 'error' | 'timeout';
    sideEffect?: 'none' | 'completed' | 'unknown';
    errorMessage?: string | null;
    persistedResult?: string;
    approvalSummary?: string | null;
    conversationSemantic?: BuiltInToolConversationSemantic;
    attachments?: ToolAttachment[];
    controlSignal?: BuiltInToolControlSignal;
    structuredPayload?: ToolEventStructuredPayload;
}

export type BuiltInToolConversationStatus =
    | 'executing'
    | 'awaiting_approval'
    | 'completed'
    | 'error'
    | 'rejected'
    | 'cancelled';
export type BuiltInToolConversationSemanticAction = ToolEventBuiltInConversationSemanticAction;
export type BuiltInToolConversationSemantic = ToolEventBuiltInConversationSemantic;
export interface BuiltInToolConversationPresentation {
    verb: string;
    content?: string;
}

/** A descriptor performs the effect only; the controlled pipeline owns its lifecycle. */
export abstract class BuiltInTool<
    TConfig = unknown,
    TContext extends BaseBuiltInToolExecutionContext = BaseBuiltInToolExecutionContext,
> {
    abstract readonly id: BuiltInToolId;
    abstract readonly displayName: string;
    abstract readonly description: string;
    abstract readonly inputSchema: ToolDeclaration['input_schema'];
    abstract readonly defaultConfig: TConfig;
    readonly adaptiveTimeoutCeilingMs?: number;

    buildToolDefinition(name: string, config: TConfig): ToolDeclaration | Promise<ToolDeclaration>;
    buildToolDefinition(name: string): ToolDeclaration | Promise<ToolDeclaration> {
        return {
            name,
            description: this.description,
            input_schema: this.inputSchema,
            adaptiveTimeoutCeilingMs: this.adaptiveTimeoutCeilingMs,
        };
    }

    parseConfig(text: string | null): TConfig;
    parseConfig(): TConfig {
        return this.defaultConfig;
    }

    prepareForTurn(
        config: TConfig,
        scope?: ToolPreparationScope
    ): Promise<BuiltInTool<TConfig, TContext>>;
    async prepareForTurn(): Promise<BuiltInTool<TConfig, TContext>> {
        return this;
    }

    isAuthorized(scope: ToolInvocationScope): Promise<boolean>;
    async isAuthorized(): Promise<boolean> {
        return true;
    }

    buildApprovalRequest(
        args: Record<string, unknown>,
        config: TConfig,
        name: string,
        context: TContext
    ): ToolApproval | null | Promise<ToolApproval | null>;
    buildApprovalRequest(): ToolApproval | null | Promise<ToolApproval | null> {
        return null;
    }

    recordApprovalRejected(
        args: Record<string, unknown>,
        config: TConfig,
        context: TContext
    ): void | Promise<void>;
    recordApprovalRejected(): void | Promise<void> {}

    buildConversationSemantic(args: Record<string, unknown>): BuiltInToolConversationSemantic;
    buildConversationSemantic(): BuiltInToolConversationSemantic {
        return { action: 'process', target: this.displayName };
    }

    buildConversationSemanticWithContext(
        args: Record<string, unknown>,
        config: TConfig,
        context: TContext
    ): BuiltInToolConversationSemantic | Promise<BuiltInToolConversationSemantic>;
    buildConversationSemanticWithContext(
        args: Record<string, unknown>
    ): BuiltInToolConversationSemantic | Promise<BuiltInToolConversationSemantic> {
        return this.buildConversationSemantic(args);
    }

    abstract execute(
        args: Record<string, unknown>,
        config: TConfig,
        context: TContext
    ): Promise<BuiltInToolExecutionResult>;
}

export type BuiltInToolGroup = readonly BuiltInTool[];

export interface ResolvedBuiltInToolCall<
    TConfig = unknown,
    TContext extends BaseBuiltInToolExecutionContext = BaseBuiltInToolExecutionContext,
> {
    entity: { id: number; tool_id: string; config_json: string | null; enabled: number };
    tool: BuiltInTool<TConfig, TContext>;
    config: TConfig;
    namespacedName: string;
}
