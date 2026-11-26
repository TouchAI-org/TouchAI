import type {
    GlowWindowApi,
    SearchWindowApi,
    SettingsWindowApi,
    TrayWindowApi,
    WindowChromeApi,
} from '@/app/api/windows/presentation';
import { createDiagnosticsAdministration } from '@/app/workflows/diagnostics';
import { createNativeWindowPresentation } from '@/platform/windows/presentation';

export function assembleWindowPresentation() {
    const native = createNativeWindowPresentation();
    const lifetime = new AbortController();
    const listeners = new Set<() => void>();
    const active = () => {
        if (lifetime.signal.aborted) throw new Error('WINDOW_CLOSED');
    };
    function command<Args extends unknown[], Result>(run: (...args: Args) => Promise<Result>) {
        return (...args: Args): Promise<Result> => {
            try {
                active();
                return run(...args);
            } catch (error) {
                return Promise.reject(error);
            }
        };
    }
    function subscription<Args extends unknown[]>(
        run: (listener: (...args: Args) => void) => Promise<() => void>
    ) {
        return async (listener: (...args: Args) => void): Promise<() => void> => {
            active();
            const unlisten = await run((...args) => {
                if (!lifetime.signal.aborted) listener(...args);
            });
            if (lifetime.signal.aborted) {
                unlisten();
                return () => undefined;
            }
            const stop = () => {
                if (listeners.delete(stop)) unlisten();
            };
            listeners.add(stop);
            return stop;
        };
    }
    const chrome: WindowChromeApi | undefined = ['main', 'settings'].includes(native.label)
        ? Object.freeze({
              minimize: command(native.chrome.minimize),
              close: command(native.chrome.close),
              isMaximized: command(native.chrome.isMaximized),
              maximize: command(native.chrome.maximize),
              unmaximize: command(native.chrome.unmaximize),
              setTitle: command(native.chrome.setTitle),
              onResized: subscription(native.chrome.onResized),
          })
        : undefined;
    const s = native.search;
    const search: SearchWindowApi | undefined =
        native.label === 'main'
            ? Object.freeze({
                  ...chrome!,
                  isAlwaysOnTop: command(s.isAlwaysOnTop),
                  setAlwaysOnTop: command(s.setAlwaysOnTop),
                  isVisible: command(s.isVisible),
                  requestSearchSurfaceRefresh: command(s.requestSearchSurfaceRefresh),
                  isFocused: command(s.isFocused),
                  startDragging: command(s.startDragging),
                  outerPosition: command(s.outerPosition),
                  innerSize: command(s.innerSize),
                  scaleFactor: command(s.scaleFactor),
                  currentMonitor: command(s.currentMonitor),
                  onMoved: subscription(s.onMoved),
                  onScaleChanged: subscription(s.onScaleChanged),
                  dragSearchWindow: command(s.dragSearchWindow),
                  hideSearchWindow: command(s.hideSearchWindow),
                  reconcileSearchWindowBlur: command(s.reconcileSearchWindowBlur),
                  openSettingsWindow: command(s.openSettingsWindow),
                  getSearchWindowRendererEpoch: command(s.getSearchWindowRendererEpoch),
                  markSearchWindowReady: command(s.markSearchWindowReady),
                  setSearchSurfaceHideOnAppBlur: command(s.setSearchSurfaceHideOnAppBlur),
                  setSearchWindowRegions: command(s.setSearchWindowRegions),
                  setSearchWindowAllowHeightOverride: command(s.setSearchWindowAllowHeightOverride),
                  resizeWindowHeight: command(s.resizeWindowHeight),
                  setSearchWindowDefaults: command(s.setSearchWindowDefaults),
                  setSearchWindowMinSize: command(s.setSearchWindowMinSize),
                  resetSearchWindowBounds: command(s.resetSearchWindowBounds),
                  getSearchWindowState: command(s.getSearchWindowState),
                  commitSearchPanelResize: command(s.commitSearchPanelResize),
                  registerGlobalShortcut: command(s.registerGlobalShortcut),
                  setSearchSurfaceShortcuts: command(s.setSearchSurfaceShortcuts),
                  setTrayStatusIndicator: command(s.setTrayStatusIndicator),
                  clearTrayStatusIndicator: command(s.clearTrayStatusIndicator),
                  showSessionStatusReminderNotification: command(
                      s.showSessionStatusReminderNotification
                  ),
                  clearSessionStatusReminderNotifications: command(
                      s.clearSessionStatusReminderNotifications
                  ),
              })
            : undefined;
    const settings: SettingsWindowApi | undefined =
        native.label === 'settings'
            ? Object.freeze({
                  ...chrome!,
                  getShortcutStatus: command(native.settings.getShortcutStatus),
              })
            : undefined;
    const tray: TrayWindowApi | undefined =
        native.label === 'tray-menu'
            ? Object.freeze({
                  showSearch: command(native.tray.showSearch),
                  openSettings: command(native.tray.openSettings),
                  quit: command(native.tray.quit),
                  closeMenu: command(native.tray.closeMenu),
                  onBlur: subscription(native.tray.onBlur),
              })
            : undefined;
    const glow: GlowWindowApi | undefined =
        native.label === 'computer-use-glow'
            ? Object.freeze({
                  readFeedback: command(native.glow.readFeedback),
                  onFeedback: subscription(native.glow.onFeedback),
              })
            : undefined;
    return Object.freeze({
        chrome,
        search,
        settings,
        tray,
        glow,
        diagnostics:
            native.label === 'settings'
                ? createDiagnosticsAdministration(lifetime.signal)
                : undefined,
        dispose() {
            lifetime.abort();
            for (const stop of [...listeners]) stop();
        },
    });
}
