import { AppEvent, eventService, type ShortcutCaptureSystemKeyEvent } from '@services/EventService';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { onMounted, onUnmounted, type Ref, watch } from 'vue';

import { isMacPlatform, normalizeLocalShortcutString } from '@/utils/shortcuts';

/**
 * 把原生层送来的系统按键事件（如 Alt+Space）拼装成快捷键字符串。
 */
export function assembleSystemKeyShortcut(
    payload: ShortcutCaptureSystemKeyEvent,
    options: { primaryLabel: 'Mod' | 'Ctrl' }
): string | null {
    const modifiers: string[] = [];
    if (payload.ctrl) {
        modifiers.push(options.primaryLabel);
    }
    if (payload.alt) {
        modifiers.push('Alt');
    }
    if (payload.shift) {
        modifiers.push('Shift');
    }

    return normalizeLocalShortcutString([...modifiers, payload.key].join('+'));
}

/**
 * 系统按键事件的订阅生命周期，组件卸载时自动退订。
 */
export function useSystemKeyCaptureSubscription(
    handler: (payload: ShortcutCaptureSystemKeyEvent) => void,
    onError?: (error: unknown) => void
) {
    let unlisten: UnlistenFn | null = null;

    onMounted(async () => {
        try {
            unlisten = await eventService.on(AppEvent.SHORTCUT_CAPTURE_SYSTEM_KEY, handler);
        } catch (error) {
            onError?.(error);
        }
    });

    onUnmounted(() => {
        unlisten?.();
        unlisten = null;
    });
}

/**
 * 在进入捕获态时挂载 window keydown 监听，退出时卸载。
 */
export function useKeydownCaptureListener(
    isActive: Ref<boolean>,
    handler: (event: KeyboardEvent) => void,
    options: { capture?: boolean } = {}
) {
    const capture = options.capture ?? false;

    watch(isActive, (active) => {
        if (active) {
            window.addEventListener('keydown', handler, { capture });
        } else {
            window.removeEventListener('keydown', handler, { capture });
        }
    });

    onUnmounted(() => {
        window.removeEventListener('keydown', handler, { capture });
    });
}

/**
 * 快捷键录入框的焦点接管与选区固定，避免录入时出现文本选中。
 */
export function useCaptureInputFocus() {
    function focusCaptureInput(event: MouseEvent) {
        event.preventDefault();
        (event.currentTarget as HTMLInputElement).focus();
    }

    function clearCaptureSelection(event: Event) {
        const input = event.currentTarget as HTMLInputElement;
        const cursorPosition = input.value.length;
        input.setSelectionRange(cursorPosition, cursorPosition);
    }

    return { focusCaptureInput, clearCaptureSelection };
}

export { isMacPlatform };
