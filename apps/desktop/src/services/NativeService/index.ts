import { autostart } from './autostart';
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
    BuiltInBashExecutionRequest,
    BuiltInBashExecutionResponse,
    ClipboardPayload,
    ComputerActionOperation,
    ComputerActionOptions,
    ComputerActionReceipt,
    ComputerActionRequest,
    ComputerActionResponse,
    ComputerActionResponseWithReceipt,
    ComputerBounds,
    ComputerCapability,
    ComputerCapabilitySnapshot,
    ComputerCoordinateTarget,
    ComputerDisplaySnapshot,
    ComputerElementSnapshot,
    ComputerElementTarget,
    ComputerExecutionMode,
    ComputerLane,
    ComputerObservationInclude,
    ComputerObservationMode,
    ComputerObservationRequest,
    ComputerObservationResponse,
    ComputerObservationTree,
    ComputerResolvedTarget,
    ComputerRoute,
    ComputerRouteHint,
    ComputerScreenshotSnapshot,
    ComputerSessionRequest,
    ComputerSessionResponse,
    ComputerTarget,
    ComputerWindowSnapshot,
    ComputerWindowTarget,
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
