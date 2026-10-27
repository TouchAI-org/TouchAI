import { autostart } from './autostart';
import { browser } from './browser';
import { builtInTools } from './builtInTools';
import { clipboard } from './clipboard';
import { database } from './database';
import { log } from './log';
import * as mcp from './mcp';
import { observability } from './observability';
import { paths } from './paths';
import { quickSearch } from './quickSearch';
import { runtime } from './runtime';
import { shortcut } from './shortcut';
import { updater } from './updater';
import { window } from './window';

export type {
    McpServerConfig,
    McpServerStatus,
    McpServerStatusInfo,
    McpToolCallResponse,
    McpToolContent,
    McpToolDefinition,
    McpTransportType,
} from './mcp';
export type { SearchSurfaceShortcutEntry } from './shortcut';
export type {
    AppUpdateChannel,
    AppUpdateChannelLatest,
    AppUpdateCheckResult,
    AppUpdateDownload,
    AppUpdateInfo,
    AppUpdateRequirement,
    BrowserActRequest,
    BrowserActResponse,
    BrowserNavigationRequest,
    BrowserObserveOperation,
    BrowserObserveRequest,
    BrowserObserveResponse,
    BrowserSessionResponse,
    BrowserStartRequest,
    BrowserStatusResponse,
    BrowserTabRequest,
    BuiltInBashEvent,
    BuiltInBashExecutionRequest,
    BuiltInBashExecutionResponse,
    BuiltInBashOutputDelta,
    BuiltInBashStreamChannel,
    BuiltInBashStreamChunk,
    ClipboardPayload,
    DiagnosticBundleFile,
    DiagnosticBundlePreview,
    DiagnosticModeStatus,
    ObservabilityLogEnvelope,
    PopupConfig,
    QuickSearchFileItem,
    QuickSearchResult,
    QuickSearchStatus,
    QuickShortcutItem,
    ResizeWindowHeightParams,
    ShowPopupWindowParams,
    TauriLogPayload,
} from './types';

export {
    autostart,
    browser,
    builtInTools,
    clipboard,
    database,
    log,
    mcp,
    observability,
    paths,
    quickSearch,
    runtime,
    shortcut,
    updater,
    window,
};

export const native = {
    window,
    shortcut,
    autostart,
    browser,
    clipboard,
    builtInTools,
    log,
    observability,
    database,
    paths,
    mcp,
    quickSearch,
    runtime,
    updater,
} as const;
