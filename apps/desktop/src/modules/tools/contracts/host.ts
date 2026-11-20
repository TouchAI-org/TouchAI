import type {
    AskUserAnswer,
    AskUserQuestion,
    ToolEvent,
    ToolEventBuiltInConversationSemantic,
    ToolEventStructuredPayload,
} from './events';

export interface ToolAttachment {
    id: string;
    attachmentId?: number;
    hash?: string;
    type: 'image' | 'file';
    path: string;
    originPath: string;
    name: string;
    size?: number;
    preview?: string;
    mimeType?: string;
    supportStatus?: 'supported' | 'unsupported-image' | 'unsupported-file';
    draftInsertionOffset?: number;
}

export interface ToolAttachmentCapabilities {
    create(type: 'image' | 'file', path: string): Promise<ToolAttachment>;
}

export interface ToolImageContent {
    type: 'image';
    data: string;
    mime_type: string;
}

export interface ToolModelReference {
    key: string;
    id: number;
    provider_id: number;
    provider_name: string;
    model_id: string;
    name: string;
    supportsImages: boolean;
}

export interface ToolMessages {
    t(key: string, params?: Record<string, string | number>): string;
    tt(text: string, params?: Record<string, string | number>): string;
}

export interface ToolModelCapabilities {
    resolve(
        taskId: string,
        reference: { providerId: number; modelId: string }
    ): Promise<ToolModelReference | null>;
    isAvailable(taskId: string, reference: ToolModelReference): Promise<boolean>;
}

export interface ToolSkillMetadata {
    name: string;
    description: string;
    path: string;
    disabled?: boolean;
}

export interface ToolSkillCapabilities {
    discover(): Promise<ToolSkillMetadata[]>;
    load(
        selected: { name: string; path: string }[]
    ): Promise<{ name: string; path: string; hash: string; contextText: string }[]>;
}

export interface ToolTaskContext {
    taskId: string;
    attemptToken: string;
    attemptGeneration: number;
    signal: AbortSignal;
    stop(): void;
    historyTarget: { sessionId: number; messageId: number };
    currentModel: ToolModelReference;
    ask(callId: string, questions: AskUserQuestion[]): Promise<AskUserAnswer[] | null>;
    present(event: ToolEvent): void;
}

export interface ToolResultDetails {
    status?: 'success' | 'error' | 'timeout';
    errorMessage?: string | null;
    conversationSemantic?: ToolEventBuiltInConversationSemantic;
    structuredPayload?: ToolEventStructuredPayload;
    attachments?: ToolAttachment[];
}

export interface ToolReceipt {
    readonly taskId: string;
    readonly attemptToken: string;
    readonly partId: number;
    readonly input: string;
    readonly attachments?: ToolAttachment[];
}
