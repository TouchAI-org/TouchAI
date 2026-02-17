import { autostart } from './autostart';
import { database } from './database';
import { log } from './log';
import * as mcp from './mcp';
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
export type { PopupConfig, ShowPopupWindowParams, TauriLogPayload } from './types';

export { autostart, database, log, mcp, shortcut, window };

export const native = {
    window,
    shortcut,
    autostart,
    log,
    database,
    mcp,
} as const;
