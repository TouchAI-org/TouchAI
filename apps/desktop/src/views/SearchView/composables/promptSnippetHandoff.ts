import type { InputHistorySnapshot } from '@/app/api/agent/history';
import type { PromptSnippetInsertionMode } from '@/app/api/settings/preferences';

interface PromptSnippetHandoffOptions {
    body: string;
    insertionMode: PromptSnippetInsertionMode;
    insertTextAtCursor: (text: string) => void;
    captureInputSnapshot: () => InputHistorySnapshot;
    closePicker: (options: { restoreFocus: boolean }) => void | Promise<void>;
    submit: (snapshot: InputHistorySnapshot) => void | Promise<void>;
}

/**
 * Sends the post-insertion composer snapshot through the normal SearchView submit path.
 * Snippets never bypass the existing attachment, queue, and history semantics.
 */
export async function handoffPromptSnippet(options: PromptSnippetHandoffOptions): Promise<void> {
    options.insertTextAtCursor(options.body);

    if (options.insertionMode === 'paste_only') {
        await options.closePicker({ restoreFocus: true });
        return;
    }

    const snapshot = options.captureInputSnapshot();
    await options.closePicker({ restoreFocus: false });
    await options.submit(snapshot);
}
