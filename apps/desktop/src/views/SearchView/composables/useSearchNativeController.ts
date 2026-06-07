import { native } from '@services/NativeService';
import { notify } from '@services/NotificationService';

import { clipboardService } from '@/services/ClipboardService';

export type { QuickShortcutItem } from '@services/NativeService';

export function useSearchNativeController() {
    return {
        notify,
        openSettingsWindow: () => native.window.openSettingsWindow(),
        readExplicitPastePayload: () => clipboardService.readExplicitPastePayload(),
        consumeShortcutAutoPastePayload: (timeoutMs: number) =>
            clipboardService.consumeShortcutAutoPastePayload(timeoutMs),
    };
}
