import type { InputHistorySnapshot } from './history';
import type { TaskExecutionMode } from './task';

export type PromptFragmentSource =
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
    id: string;
    source: PromptFragmentSource;
    content: string;
}

/** The shipped history snapshot is a Desktop record, not provider transport. */
export interface PromptSnapshotAttachmentSummary {
    id: string;
    alias: string;
    name: string;
    type: 'image' | 'file';
    size: number | null;
    mimeType: string | null;
    originPath: string;
    attachmentId: number | null;
    hash: string | null;
    derivedKind: 'image' | 'pdf' | 'text' | 'code' | 'structured-text' | 'binary' | 'directory';
    semanticIntent:
        | 'visual-reference'
        | 'document-content'
        | 'textual-content'
        | 'binary-content'
        | 'directory-reference';
    supportStatus?: 'supported' | 'unsupported-image' | 'unsupported-file' | null;
}

export interface PromptAssembly {
    executionMode: TaskExecutionMode;
    modelLanguageContext: { locale: 'zh-CN' | 'en-US'; label: string };
    fragments: PromptFragment[];
    userPrompt: string;
    attachments: PromptSnapshotAttachmentSummary[];
    skills?: { name: string; path: string; hash: string; activatedBy: 'user_tag' | 'model_tool' }[];
}

export type PromptInputSnapshot = Pick<
    InputHistorySnapshot,
    'skills' | 'editorDoc' | 'excludeFromHistory'
>;

export interface PromptSnapshot extends PromptAssembly {
    id: string;
    createdAt: string;
    systemPrompt: string;
    inputSnapshot?: PromptInputSnapshot;
    messageInputSnapshots?: Record<string, PromptInputSnapshot>;
}
