import type {
    PromptSnippet,
    PromptSnippetInsertionMode,
    PromptSnippetStorageIssue,
} from '@/app/api/settings/preferences';

export type { PromptSnippet };

export interface PromptSnippetPickerData {
    items: PromptSnippet[];
    insertionMode: PromptSnippetInsertionMode;
    storageIssue: PromptSnippetStorageIssue;
    toggleShortcut: string | null;
}
