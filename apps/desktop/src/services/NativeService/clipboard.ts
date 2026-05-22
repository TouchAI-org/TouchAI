import { invoke } from '@tauri-apps/api/core';

import type { ClipboardPayload } from './types';

export const clipboard = {
    /**
     * 读取当前剪贴板 payload。
     */
    readClipboardPayload(): Promise<ClipboardPayload | null> {
        return invoke('read_clipboard_payload');
    },

    /**
     * 消费快捷键 auto-paste payload。
     */
    consumeShortcutAutoPastePayload(maxAgeMs: number): Promise<ClipboardPayload | null> {
        return invoke('consume_shortcut_auto_paste_payload', { maxAgeMs });
    },

    /**
     * 写入剪贴板文本。
     */
    writeClipboardText(text: string): Promise<void> {
        return invoke('write_clipboard_text', { text });
    },
} as const;
