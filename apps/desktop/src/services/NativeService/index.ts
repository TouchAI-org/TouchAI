import { autostart } from './autostart';
import { browser } from './browser';
import { builtInTools } from './builtInTools';
import { clipboard } from './clipboard';
import { database } from './database';
import { log } from './log';
import * as mcp from './mcp';
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
    BuiltInBashExecutionRequest,
    BuiltInBashExecutionResponse,
    ClipboardPayload,
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
    database,
    paths,
    mcp,
    quickSearch,
    runtime,
    updater,
} as const;
