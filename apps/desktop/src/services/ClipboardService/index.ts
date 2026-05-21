import { native } from '@/services/NativeService';
import type { ClipboardPayload } from '@/services/NativeService/types';

let lastAutoPasteSnapshotId: string | null = null;

/**
 * 读取显式粘贴使用的剪贴板 payload。
 */
async function readExplicitPastePayload(): Promise<ClipboardPayload | null> {
    return native.clipboard.readClipboardPayload();
}

/**
 * 消费快捷键 auto-paste 使用的剪贴板 payload。
 */
async function consumeShortcutAutoPastePayload(maxAgeMs: number): Promise<ClipboardPayload | null> {
    const payload = await native.clipboard.consumeShortcutAutoPastePayload(maxAgeMs);
    if (!payload) {
        return null;
    }

    // native 已做一次去重；前端再挡一层，避免页面重复 focus 或异步重入时重复投影。
    if (payload.snapshotId === lastAutoPasteSnapshotId) {
        return null;
    }

    lastAutoPasteSnapshotId = payload.snapshotId;
    return payload;
}

/**
 * 将纯文本写入系统剪贴板。
 */
async function writeText(text: string) {
    await native.clipboard.writeClipboardText(text);
}

/**
 * 重置前端 auto-paste 快照去重状态。
 */
function resetAutoPasteGuard() {
    lastAutoPasteSnapshotId = null;
}

export const clipboardService = {
    readExplicitPastePayload,
    consumeShortcutAutoPastePayload,
    writeText,
    resetAutoPasteGuard,
} as const;
