import { autostart } from './autostart';
import { builtInTools } from './builtInTools';
import { database } from './database';
import { log } from './log';
import * as mcp from './mcp';
import { paths } from './paths';
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
    BuiltInBashExecutionRequest,
    BuiltInBashExecutionResponse,
    PopupConfig,
    QuickSearchFileItem,
    QuickSearchStatus,
    QuickShortcutItem,
    ResizeWindowHeightParams,
    ShowPopupWindowParams,
    TauriLogPayload,
} from './types';

export { autostart, builtInTools, database, log, mcp, paths, quickSearch, shortcut, window };

export const native = {
    window,
    shortcut,
    autostart,
    builtInTools,
    log,
    database,
    paths,
    mcp,
    quickSearch,
} as const;
