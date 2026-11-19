import { mockWindows } from '@tauri-apps/api/mocks';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { describe, expect, it } from 'vitest';

import { initializeSearchWindow } from '@/app/bootstrap/search';

const snapshot = {
    snapshotId: 'shortcut-snapshot',
    observedAt: 1,
    text: 'clipboard text',
    imagePaths: [],
    filePaths: [],
    fragments: [{ type: 'text', text: 'clipboard text' }],
};

describe('given the production clipboard draft lifetime', () => {
    it('user given a secondary native window when claiming the main label then cannot create a local reader', () => {
        mockWindows('settings');
        expect(() => initializeSearchWindow('main')).toThrow('MAIN_EXECUTION_HOST_REQUIRED');
        expect(getTauriInvokeCalls('read_clipboard_payload')).toEqual([]);
    });
    it('user given independent main windows when consuming a repeated shortcut then each accepts it once', async () => {
        mockTauriCommand('consume_shortcut_auto_paste_payload', snapshot);
        const first = initializeSearchWindow('main');
        const second = initializeSearchWindow('main');
        try {
            expect(await first.clipboard!.consumeShortcutAutoPastePayload(3000)).toEqual(snapshot);
            expect(await first.clipboard!.consumeShortcutAutoPastePayload(3000)).toBeNull();
            expect(await second.clipboard!.consumeShortcutAutoPastePayload(3000)).toEqual(snapshot);
        } finally {
            first.dispose();
            second.dispose();
        }
    });

    it.each(['settings', 'tray-menu', 'computer-use-glow', null])(
        'user given a secondary window %s when accessing clipboard drafts then has no local reader',
        (label) => {
            const window = initializeSearchWindow(label);
            expect(window.clipboard).toBeUndefined();
            expect(getTauriInvokeCalls('read_clipboard_payload')).toEqual([]);
            window.dispose();
        }
    );

    it('user given a pending read when main closes then gets cancellation and no late file persistence', async () => {
        const read = Promise.withResolvers<unknown>();
        mockTauriCommand('read_clipboard_payload', () => read.promise);
        const window = initializeSearchWindow('main');
        const file = new File([new Uint8Array([1, 2, 3])], 'report.pdf', {
            type: 'application/pdf',
        });
        const result = window.clipboard!.readExplicitPastePayload({
            getData: () => '',
            items: [] as unknown as DataTransferItemList,
            files: [file] as unknown as FileList,
        });
        const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
        window.dispose();
        await rejected;
        read.resolve(null);
        await Promise.resolve();
        await Promise.resolve();
        expect(getTauriInvokeCalls('database_query')).toEqual([]);
        expect(getTauriInvokeCalls('get_app_directory_path')).toEqual([]);
    });

    it('user given a closed main reader when requesting another paste then starts no native effect', async () => {
        const window = initializeSearchWindow('main');
        window.dispose();
        await expect(window.clipboard!.readExplicitPastePayload()).rejects.toMatchObject({
            name: 'AbortError',
        });
        expect(getTauriInvokeCalls('read_clipboard_payload')).toEqual([]);
    });
});
