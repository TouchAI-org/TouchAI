import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { currentMonitor, getCurrentWindow } from '@tauri-apps/api/window';
import { exit } from '@tauri-apps/plugin-process';

import { native } from '@/platform/native';

/** The SDK handles stay in platform; callers receive declared commands and value events only. */
export function createNativeWindowPresentation() {
    const current = getCurrentWindow();
    return {
        label: current.label,
        chrome: {
            minimize: () => current.minimize(),
            close: () => current.close(),
            isMaximized: () => current.isMaximized(),
            maximize: () => current.maximize(),
            unmaximize: () => current.unmaximize(),
            setTitle: (title: string) => current.setTitle(title),
            onResized: (listener: () => void) => current.onResized(listener),
        },
        search: {
            isAlwaysOnTop: () => current.isAlwaysOnTop(),
            setAlwaysOnTop: (value: boolean) => current.setAlwaysOnTop(value),
            // Logical visibility, not window-server visibility: a warm-parked
            // macOS window is ordered in but not presented to the user.
            isVisible: () => native.window.isSearchSurfaceVisible(),
            isFocused: () => current.isFocused(),
            startDragging: () => current.startDragging(),
            outerPosition: async () => {
                const { x, y } = await current.outerPosition();
                return { x, y };
            },
            innerSize: async () => {
                const { width, height } = await current.innerSize();
                return { width, height };
            },
            scaleFactor: () => current.scaleFactor(),
            currentMonitor: async () => {
                const monitor = await currentMonitor();
                return monitor
                    ? {
                          position: { ...monitor.position },
                          size: { ...monitor.size },
                          workArea: {
                              position: { ...monitor.workArea.position },
                              size: { ...monitor.workArea.size },
                          },
                          scaleFactor: monitor.scaleFactor,
                      }
                    : null;
            },
            onMoved: (listener: (event: { payload: { x: number; y: number } }) => void) =>
                current.onMoved(({ payload }) =>
                    listener({ payload: { x: payload.x, y: payload.y } })
                ),
            onScaleChanged: (listener: (event: { payload: { scaleFactor: number } }) => void) =>
                current.onScaleChanged(({ payload }) =>
                    listener({ payload: { scaleFactor: payload.scaleFactor } })
                ),
            ...native.window,
            registerGlobalShortcut: (shortcut: string) =>
                native.shortcut.registerGlobalShortcut(shortcut),
            setSearchSurfaceShortcuts: (entries: { actionId: string; shortcut: string }[]) =>
                native.shortcut.setSearchSurfaceShortcuts(entries),
        },
        settings: { getShortcutStatus: () => native.shortcut.getShortcutStatus() },
        tray: {
            showSearch: () => native.window.showSearchWindow(),
            openSettings: () => native.window.openSettingsWindow(),
            quit: () => exit(0),
            closeMenu: () => native.window.closeTrayMenu(),
            onBlur: (listener: () => void) =>
                getCurrentWebviewWindow().listen('tauri://blur', listener),
        },
        glow: {
            readFeedback: () => native.computerUse.feedback(),
            onFeedback: (
                listener: (
                    feedback: Awaited<ReturnType<typeof native.computerUse.feedback>>
                ) => void
            ) =>
                getCurrentWebviewWindow().listen<
                    Awaited<ReturnType<typeof native.computerUse.feedback>>
                >('computer-use-glow-pulse', ({ payload }) => listener(payload)),
        },
    };
}
