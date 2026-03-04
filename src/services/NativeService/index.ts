import { autostart } from './autostart';
import { database } from './database';
import { log } from './log';
import * as mcp from './mcp';
import { quickSearch } from './quickSearch';
import { shortcut } from './shortcut';
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
    PopupConfig,
    QuickSearchStatus,
    QuickShortcutItem,
    ResizeWindowHeightParams,
    ShowPopupWindowParams,
    TauriLogPayload,
} from './types';

export { autostart, database, log, mcp, quickSearch, shortcut, window };

export const native = {
    window,
    shortcut,
    autostart,
    log,
    database,
    mcp,
    quickSearch,
} as const;
