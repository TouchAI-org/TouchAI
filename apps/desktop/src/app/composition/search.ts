import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';

import { createClipboardDrafts } from '@/modules/attachments';
import { createSearchHost, loadFileReferenceSuggestions } from '@/modules/search';
import { quickSearch } from '@/platform/native/quickSearch';
import { requireMainExecutionHost } from '@/platform/windows/execution';

export function assembleSearchWindow() {
    requireMainExecutionHost();
    const host = createSearchHost({
        files: quickSearch,
        openFile: openPath,
        revealFile: revealItemInDir,
        loadReferenceSuggestions: (limit, signal) =>
            loadFileReferenceSuggestions(quickSearch, limit, signal),
    });
    const clipboard = createClipboardDrafts();
    return Object.freeze({
        api: host.api,
        clipboard: clipboard.api,
        dispose() {
            clipboard.dispose();
            host.dispose();
        },
    });
}
