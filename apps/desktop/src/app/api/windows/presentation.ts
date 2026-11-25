import { inject, type InjectionKey } from 'vue';

import type {
    ComputerUseFeedback,
    DiagnosticBundlePreview,
    DiagnosticModeStatus,
    ResizeWindowHeightParams,
    SearchPanelResizeCommit,
    SearchSurfacePreparation,
    SearchWindowDefaultSize,
    SearchWindowMinimumSize,
    SearchWindowRegion,
    SearchWindowRegionUpdate,
    SearchWindowState,
    SessionStatusReminderNotificationPayload,
    TrayStatusIndicator,
    WindowMonitor,
} from './contracts';

export type * from './contracts';
export type StopWindowListener = () => void;

export interface WindowChromeApi {
    minimize(): Promise<void>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
    maximize(): Promise<void>;
    unmaximize(): Promise<void>;
    setTitle(title: string): Promise<void>;
    onResized(listener: () => void): Promise<StopWindowListener>;
}
export interface SearchWindowApi extends WindowChromeApi {
    isAlwaysOnTop(): Promise<boolean>;
    setAlwaysOnTop(value: boolean): Promise<void>;
    isVisible(): Promise<boolean>;
    isFocused(): Promise<boolean>;
    startDragging(): Promise<void>;
    outerPosition(): Promise<{ x: number; y: number }>;
    innerSize(): Promise<{ width: number; height: number }>;
    scaleFactor(): Promise<number>;
    currentMonitor(): Promise<WindowMonitor | null>;
    onMoved(
        listener: (event: { payload: { x: number; y: number } }) => void
    ): Promise<StopWindowListener>;
    onScaleChanged(
        listener: (event: { payload: { scaleFactor: number } }) => void
    ): Promise<StopWindowListener>;
    dragSearchWindow(): Promise<void>;
    hideSearchWindow(): Promise<void>;
    reconcileSearchWindowBlur(): Promise<void>;
    openSettingsWindow(): Promise<void>;
    getSearchWindowRendererEpoch(): Promise<number>;
    markSearchWindowReady(rendererEpoch: number): Promise<SearchSurfacePreparation | null>;
    setSearchSurfaceHideOnAppBlur(value: boolean, delayMs?: number): Promise<void>;
    setSearchWindowRegions(
        regions: SearchWindowRegion[],
        generation: number,
        preparation?: SearchSurfacePreparation | null
    ): Promise<SearchWindowRegionUpdate>;
    setSearchWindowAllowHeightOverride(value: boolean): Promise<void>;
    resizeWindowHeight(params: ResizeWindowHeightParams): Promise<void>;
    setSearchWindowDefaults(defaults: SearchWindowDefaultSize): Promise<SearchWindowDefaultSize>;
    setSearchWindowMinSize(size: SearchWindowMinimumSize): Promise<void>;
    resetSearchWindowBounds(): Promise<void>;
    getSearchWindowState(): Promise<SearchWindowState>;
    commitSearchPanelResize(resize: SearchPanelResizeCommit): Promise<SearchWindowState>;
    registerGlobalShortcut(shortcut: string): Promise<void>;
    setSearchSurfaceShortcuts(entries: { actionId: string; shortcut: string }[]): Promise<void>;
    setTrayStatusIndicator(status: TrayStatusIndicator): Promise<void>;
    clearTrayStatusIndicator(): Promise<void>;
    showSessionStatusReminderNotification(
        payload: SessionStatusReminderNotificationPayload
    ): Promise<void>;
    clearSessionStatusReminderNotifications(): Promise<void>;
}
export interface SettingsWindowApi extends WindowChromeApi {
    getShortcutStatus(): Promise<[boolean, string | null]>;
}
export interface TrayWindowApi {
    showSearch(): Promise<void>;
    openSettings(): Promise<void>;
    quit(): Promise<void>;
    closeMenu(): Promise<void>;
    onBlur(listener: () => void): Promise<StopWindowListener>;
}
export interface GlowWindowApi {
    readFeedback(): Promise<ComputerUseFeedback>;
    onFeedback(listener: (feedback: ComputerUseFeedback) => void): Promise<StopWindowListener>;
}
export interface DiagnosticsAdminApi {
    readStatus(): Promise<DiagnosticModeStatus>;
    setEnabled(enabled: boolean): Promise<DiagnosticModeStatus>;
    preview(): Promise<DiagnosticBundlePreview>;
    exportWithPicker(): Promise<boolean>;
    dismissCrashes(): Promise<void>;
}
export const windowChromeApiKey: InjectionKey<WindowChromeApi> = Symbol('touchai.window.chrome');
export const searchWindowApiKey: InjectionKey<SearchWindowApi> = Symbol('touchai.window.search');
export const settingsWindowApiKey: InjectionKey<SettingsWindowApi> =
    Symbol('touchai.window.settings');
export const trayWindowApiKey: InjectionKey<TrayWindowApi> = Symbol('touchai.window.tray');
export const glowWindowApiKey: InjectionKey<GlowWindowApi> = Symbol('touchai.window.glow');
export const diagnosticsAdminApiKey: InjectionKey<DiagnosticsAdminApi> = Symbol(
    'touchai.settings.diagnostics'
);
function requireCapability<T>(key: InjectionKey<T>): T {
    const api = inject(key);
    if (!api) throw new Error('WINDOW_CAPABILITY_UNAVAILABLE');
    return api;
}
export const useWindowChromeApi = () => requireCapability(windowChromeApiKey);
export const useSearchWindowApi = () => requireCapability(searchWindowApiKey);
export const useSettingsWindowApi = () => requireCapability(settingsWindowApiKey);
export const useTrayWindowApi = () => requireCapability(trayWindowApiKey);
export const useGlowWindowApi = () => requireCapability(glowWindowApiKey);
export const useDiagnosticsAdminApi = () => requireCapability(diagnosticsAdminApiKey);
