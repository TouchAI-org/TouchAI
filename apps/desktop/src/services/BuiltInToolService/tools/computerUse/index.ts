// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { computerUseService, targetKey } from '@services/ComputerUseService';
import { disabledToolGroup, toolGroup } from '@services/ComputerUseService/capabilities';
import { reportedPointer } from '@services/ComputerUseService/pointer';
import { log } from '@services/ObservabilityService';

import { t, tt } from '@/i18n';
import type {
    AiToolDefinition,
    ToolApprovalRequest,
} from '@/services/AgentService/contracts/tooling';
import {
    type AttachmentIndex,
    getModelAttachmentCapabilities,
} from '@/services/AgentService/infrastructure/attachments';
import { extractMcpToolAttachments } from '@/services/AgentService/infrastructure/mcp/utils';
import type { McpToolContent } from '@/services/NativeService';
import { truncateText } from '@/utils/text';

import type {
    BaseBuiltInToolExecutionContext,
    BuiltInToolExecutionResult,
    BuiltInToolGroup,
} from '../../types';
import { BuiltInTool } from '../../types';
import { AGENT_DESKTOP_INSTRUCTIONS, agentDesktopBatchError } from './agentDesktop';
import { isRecord, normalizeComputerUseArguments } from './arguments';

type ComputerAction =
    | 'observe'
    | 'desktop_state'
    | 'list_windows'
    | 'list_apps'
    | 'click'
    | 'double_click'
    | 'right_click'
    | 'drag'
    | 'type'
    | 'key'
    | 'hotkey'
    | 'scroll'
    | 'set_value'
    | 'invoke_menu'
    | 'bring_to_front'
    | 'set_window_frame'
    | 'verify_state'
    | 'zoom'
    | 'clipboard_read'
    | 'clipboard_write'
    | 'parse_visual_regions'
    | 'screen_size'
    | 'cursor_position'
    | 'guide'
    | 'launch'
    | 'call'
    | 'run_steps'
    | 'run_script';

interface ComputerUseConfig {
    allowForeground: boolean;
}

const MUTATING: ReadonlySet<ComputerAction> = new Set([
    'click',
    'double_click',
    'right_click',
    'drag',
    'type',
    'key',
    'hotkey',
    'scroll',
    'set_value',
    'invoke_menu',
    'bring_to_front',
    'set_window_frame',
    'clipboard_write',
    'launch',
    'call',
    'run_steps',
    'run_script',
]);

const REQUIRES_APPROVAL: ReadonlySet<ComputerAction> = new Set([...MUTATING, 'clipboard_read']);

const FOREGROUND_CAPABLE: ReadonlySet<ComputerAction> = new Set([
    'click',
    'double_click',
    'right_click',
    'drag',
    'type',
    'key',
    'hotkey',
    'scroll',
    'set_value',
]);

const DRIVER_TOOL: Record<ComputerAction, string> = {
    observe: 'get_window_state',
    desktop_state: 'get_desktop_state',
    list_windows: 'list_windows',
    list_apps: 'list_apps',
    click: 'click',
    double_click: 'double_click',
    right_click: 'right_click',
    drag: 'drag',
    type: 'type_text',
    key: 'press_key',
    hotkey: 'hotkey',
    scroll: 'scroll',
    set_value: 'set_value',
    invoke_menu: 'invoke_menu',
    bring_to_front: 'bring_to_front',
    set_window_frame: 'set_window_frame',
    verify_state: 'verify_state',
    zoom: 'zoom',
    clipboard_read: 'clipboard_read',
    clipboard_write: 'clipboard_write',
    parse_visual_regions: 'parse_visual_regions',
    screen_size: 'get_screen_size',
    cursor_position: 'get_cursor_position',
    guide: 'get_guide',
    launch: 'launch_app',
    call: '',
    run_steps: 'run_steps',
    run_script: 'run_script',
};

function normalizeAction(value: unknown): ComputerAction | null {
    return typeof value === 'string' && value in DRIVER_TOOL ? (value as ComputerAction) : null;
}

async function normalizeRequest(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if ((await computerUseService.loadDriver()) === 'agent-desktop') {
        if (['list_tools', 'describe_tool', 'call'].includes(String(input.action)))
            return normalizeComputerUseArguments(input);
        const catalog = await computerUseService.listTools();
        if (!catalog.some((tool) => tool.name === input.action))
            throw new Error('unsupported_driver_action; use list_tools for the selected driver');
        const { action, ...fields } = input;
        return normalizeComputerUseArguments({ ...fields, action: 'call', tool: action });
    }
    if (
        normalizeAction(input.action) ||
        input.action === 'list_tools' ||
        input.action === 'describe_tool'
    )
        return normalizeComputerUseArguments(input);
    const catalog = await computerUseService.listTools();
    if (!catalog.some((tool) => tool.name === input.action)) return input;
    const { action, ...fields } = input;
    return normalizeComputerUseArguments({ ...fields, action: 'call', tool: action });
}

function isTargeted(args: Record<string, unknown>): boolean {
    return typeof args.pid === 'number' && typeof args.window_id === 'number';
}

function requiresForeground(action: ComputerAction, args: Record<string, unknown>): boolean {
    if (action === 'bring_to_front') {
        return true;
    }
    if (!FOREGROUND_CAPABLE.has(action)) {
        return false;
    }
    return (
        args.foreground === true ||
        args.scope === 'desktop' ||
        action === 'hotkey' ||
        (action === 'type' &&
            typeof args.text === 'string' &&
            /[\u{10000}-\u{10FFFF}]/u.test(args.text)) ||
        (action === 'key' && Array.isArray(args.modifiers) && args.modifiers.length > 0)
    );
}

function isHotkeyModifier(value: string): boolean {
    return ['ctrl', 'control', 'shift', 'alt', 'win', 'windows', 'cmd', 'command'].includes(
        value.trim().toLowerCase()
    );
}

function validateHotkey(args: Record<string, unknown>): string | null {
    if (!Array.isArray(args.keys)) return 'hotkey.keys must be an array';
    if (args.keys.length < 2) return 'hotkey.keys must contain at least two keys';
    if (args.keys.some((value) => typeof value !== 'string' || value.trim().length === 0)) {
        return 'hotkey.keys must contain non-empty strings';
    }
    const nonModifiers = args.keys.filter(
        (value): value is string => typeof value === 'string' && !isHotkeyModifier(value)
    );
    if (nonModifiers.length !== 1 || args.keys[args.keys.length - 1] !== nonModifiers[0]) {
        return 'hotkey.keys must contain modifiers followed by one non-modifier key';
    }
    return null;
}

function isForegroundAllowed(settings: { allowForeground: boolean }): boolean {
    return settings.allowForeground;
}

function normalizeAppName(value: string): string {
    const trimmed = value.trim().toLowerCase();
    const basename = trimmed.split(/[\\/]/).pop() ?? trimmed;
    return basename.endsWith('.exe') ? basename.slice(0, -4) : basename;
}

function launchTarget(args: Record<string, unknown>): string | null {
    for (const key of ['path', 'launch_path', 'app', 'aumid', 'bundle_id']) {
        const value = args[key];
        if (typeof value === 'string' && value.trim()) return value;
    }
    return null;
}

function isAppAllowed(settings: { allowedApps: string[] }, args: Record<string, unknown>): boolean {
    if (settings.allowedApps.length === 0) return true;
    const target = launchTarget(args);
    if (!target) return false;
    const normalized = normalizeAppName(target);
    return settings.allowedApps.some((entry) => normalizeAppName(entry) === normalized);
}

function compactArgs(values: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function pickArgs(action: ComputerAction, args: Record<string, unknown>): Record<string, unknown> {
    const target = compactArgs({
        pid: args.pid,
        window_id: args.window_id,
    });
    const delivery = FOREGROUND_CAPABLE.has(action)
        ? { delivery_mode: requiresForeground(action, args) ? 'foreground' : 'background' }
        : {};
    const point = compactArgs({
        x: args.x,
        y: args.y,
        scope: args.scope,
    });
    switch (action) {
        case 'call':
        case 'run_steps':
        case 'run_script':
            return args;
        case 'guide':
            return compactArgs({ topic: args.topic });
        case 'screen_size':
        case 'cursor_position':
        case 'list_apps':
            return {};
        case 'list_windows':
            return compactArgs({
                app: args.app,
                on_screen_only: args.on_screen_only,
                pid: args.pid,
            });
        case 'desktop_state':
            return compactArgs({ max_image_dimension: args.max_image_dimension });
        case 'observe':
            return compactArgs({
                ...target,
                display_only: args.display_only,
                full_output: args.full_output,
                include_accessibility_tree: args.include_accessibility_tree,
                include_screenshot: args.include_screenshot ?? false,
                max_depth: args.max_depth,
                max_dimension: args.max_dimension,
                max_elements: args.max_elements,
                max_image_dimension: args.max_image_dimension,
                query: args.query,
                since: args.since,
                timeout_ms: args.timeout_ms ?? 3000,
                tree_format: args.tree_format,
                verbose: args.verbose,
            });
        case 'click':
            return compactArgs({
                ...target,
                ...delivery,
                ...point,
                action: args.element_action === 'expand' ? 'expand' : undefined,
                button: args.button,
                capture_id: args.capture_id,
                count: args.count,
                element_token: args.element_token,
                from_zoom: args.from_zoom,
                modifier: args.modifier,
            });
        case 'double_click':
        case 'right_click':
            return compactArgs({
                ...target,
                ...delivery,
                x: args.x,
                y: args.y,
                element_token: args.element_token,
                from_zoom: args.from_zoom,
                modifier: args.modifier,
            });
        case 'drag':
            return compactArgs({
                ...target,
                ...delivery,
                button: args.button,
                duration_ms: args.duration_ms,
                from_x: args.from_x,
                from_y: args.from_y,
                from_zoom: args.from_zoom,
                modifier: args.modifier,
                scope: args.scope,
                steps: args.steps,
                to_x: args.to_x,
                to_y: args.to_y,
            });
        case 'type':
            return compactArgs({
                ...target,
                ...delivery,
                ...point,
                delay_ms: args.delay_ms,
                element_token: args.element_token,
                text: args.text,
            });
        case 'key':
            return compactArgs({
                ...target,
                ...delivery,
                ...point,
                element_token: args.element_token,
                key: args.key,
                modifiers: args.modifiers,
            });
        case 'hotkey':
            if (args.x === undefined && args.y === undefined && Array.isArray(args.keys)) {
                return compactArgs({
                    ...target,
                    ...delivery,
                    ...point,
                    element_token: args.element_token,
                    key: args.keys[args.keys.length - 1],
                    modifiers: args.keys.slice(0, -1),
                });
            }
            return compactArgs({
                ...target,
                ...delivery,
                ...point,
                element_token: args.element_token,
                keys: args.keys,
            });
        case 'scroll':
            return compactArgs({
                ...target,
                ...delivery,
                ...point,
                amount: args.amount,
                by: args.by,
                element_token: args.element_token,
                direction: args.direction,
            });
        case 'set_value':
            return compactArgs({
                ...target,
                ...delivery,
                element_token: args.element_token,
                value: args.value,
            });
        case 'invoke_menu':
            return compactArgs({ ...target, path: args.menu_path });
        case 'bring_to_front':
            return target;
        case 'set_window_frame':
            return compactArgs({
                ...target,
                height: args.height,
                width: args.width,
                x: args.x,
                y: args.y,
            });
        case 'verify_state':
            return compactArgs({
                ...target,
                expect: args.expect,
                include_screenshot: args.include_screenshot,
                stable_samples: args.stable_samples,
                timeout_ms: args.timeout_ms,
            });
        case 'zoom':
            return compactArgs({
                ...target,
                x1: args.x1,
                x2: args.x2,
                y1: args.y1,
                y2: args.y2,
            });
        case 'clipboard_read':
            return compactArgs({ include_text: args.include_text });
        case 'clipboard_write':
            return compactArgs({
                file_path: args.file_path,
                image_path: args.image_path,
                text: args.text,
            });
        case 'parse_visual_regions':
            return compactArgs({
                capture_id: args.capture_id,
                options: compactArgs({
                    kinds: args.kinds,
                    max_regions: args.max_regions,
                    min_confidence: args.min_confidence,
                }),
            });
        case 'launch': {
            return compactArgs({
                additional_arguments: args.additional_arguments,
                aumid: args.aumid,
                bundle_id: args.bundle_id,
                name: args.app,
                path: args.path,
                start_minimized: args.start_minimized,
                urls: args.urls,
                launch_path: args.launch_path,
            });
        }
    }
}

function describeActionDetail(action: ComputerAction, args: Record<string, unknown>): string {
    switch (action) {
        case 'type':
            return truncateText(String(args.text ?? ''), 80);
        case 'key':
            return [args.modifiers, args.key].flat().filter(Boolean).join('+');
        case 'hotkey':
            return Array.isArray(args.keys) ? args.keys.join('+') : '';
        case 'click':
        case 'double_click':
        case 'right_click':
            return String(
                args.element_token ??
                    [args.x, args.y].filter((value) => value !== undefined).join(',')
            );
        case 'drag':
            return `${String(args.from_x ?? '')},${String(args.from_y ?? '')} -> ${String(
                args.to_x ?? ''
            )},${String(args.to_y ?? '')}`;
        case 'set_window_frame':
            return `${String(args.width ?? '')}x${String(args.height ?? '')} @ ${String(
                args.x ?? ''
            )},${String(args.y ?? '')}`;
        case 'invoke_menu':
            return Array.isArray(args.menu_path) ? args.menu_path.join(' > ') : '';
        case 'set_value':
            return truncateText(String(args.value ?? ''), 80);
        case 'clipboard_read':
            return args.include_text === true ? 'read text' : 'read types';
        case 'clipboard_write':
            return truncateText(String(args.text ?? args.image_path ?? args.file_path ?? ''), 80);
        case 'launch':
            return String(args.path ?? args.app ?? args.launch_path ?? args.aumid ?? '');
        case 'scroll':
            return `${String(args.direction ?? '')} ${String(args.amount ?? '')}`.trim();
        default:
            return '';
    }
}

class ComputerUseTool extends BuiltInTool<ComputerUseConfig> {
    readonly id = 'computer_use' as const;
    get displayName(): string {
        return t('settings.nav.computerUse.label');
    }
    readonly description =
        'All installed driver capabilities are available through action="call", tool=<native name>, arguments=<native arguments>. Native names without an existing action alias also accept action=<native name>. Use list_tools for the enabled catalog or describe_tool with tool for its exact schema. ' +
        'For aliases put fields at the top level or inside arguments consistently; do not duplicate conflicting fields. Example: {action:"observe",arguments:{pid:123,window_id:456}}. ' +
        'For browsers: list_windows without an app-name filter first, then browser_prepare arguments={pid,window_id,strategy:{kind:"existing_profile"},delivery_mode:"foreground"} when foreground is allowed. strategy is an object, not "cdp"; prepare does not accept url. Bind using get_browser_state {pid,window_id}, THEN read DOM using get_browser_state {target_id,tab_id}. A bind response is not a page snapshot. Use its DOM refs with browser_* tools instead of falling back to legacy page UIA queries or repeatedly taking desktop screenshots. Keep the same session label throughout, or omit it throughout; changing it invalidates target/tab/ref capabilities. browser_navigate requires target_id,tab_id,url. browser_download only activates a live ref that actually initiates a download; it cannot save an arbitrary image URL. For an image without a download link, use the browser image context menu and Save image as. Read describe_tool before an unfamiliar native tool. Legacy page JavaScript mutations are disabled by the driver. On elevated Windows, launch by an observed executable path with start_minimized:true. ' +
        'For known sequential actions prefer action="run_steps", arguments={pid,window_id,steps:[{tool:"press_key",args:{key:"a",modifiers:["ctrl"]}},{tool:"type_text",args:{text:"complete text"}}],delivery_mode:"foreground",observe:{}}. This runs in order and returns one final observation, saving model rounds. Put wait_for/expect on steps to verify transitions. Stop at new unknown screens. Never send dependent desktop actions as separate parallel tool calls. ' +
        'run_steps accepts ONLY these step tools: click, double_click, right_click, set_value, type_text, press_key, hotkey, scroll, drag, move_cursor. Window actions such as bring_to_front, launch_app and set_window_frame must run separately BEFORE the batch, never inside steps. observe is a batch option, not a step. ' +
        'For branching or loops use action="run_script", arguments={script:"...",timeout_ms:30000,max_calls:100}; describe_tool first to learn the sandboxed cua API. Full access and enabled dependent groups are required for scripts and trajectory replay. A script has no shell, filesystem or network APIs. Completed steps are not rolled back; never replay the whole batch after a partial failure. ' +
        'Observe and drive local desktop apps through Windows accessibility and input APIs. ' +
        'Use list_windows with on_screen_only=false to find an existing app, including minimized windows, before launch. If off-screen or minimized, use bring_to_front then observe; do not click the minimized title bar or relaunch it. ' +
        'Call observe before element actions and use tokens from the latest snapshot. Use set_value only for controls supporting ValuePattern; for WebView inputs use click then type, or a foreground hotkey to focus the field. ' +
        'Pixel actions use screenshot coordinates from observe. For a background_unavailable result, retry the same action with foreground=true only when foreground access is enabled. ' +
        'In full-access mode with foreground enabled, type, key and scroll default to foreground delivery; set foreground=false to explicitly request background delivery. Zoom regions must be at most 500 screenshot pixels wide. For native dropdowns, prefer focusing the control and using keyboard selection when popup items do not appear in the screenshot. ' +
        'Always pass both pid and window_id for window actions, including bring_to_front. Use hotkey for modifier combinations (Ctrl+Shift+S for Save As), bring_to_front only when a surface must stay focused, and set_window_frame to move or resize. Prefer one type call for complete text, use observe query to narrow large trees, and reuse the post-action snapshot instead of observing twice. For read-only tasks, finish once the requested facts are present; do not scroll or take extra screenshots just to confirm the same text. ' +
        'An unconfirmed action includes a fresh window snapshot when available: inspect that state, continue with its tokens, and do not repeat the action just because effect is unverifiable. ' +
        'Use guide when you need driver guidance for drag, menus, or permissions.';
    readonly defaultConfig: ComputerUseConfig = { allowForeground: false };
    readonly inputSchema: BuiltInTool['inputSchema'] = {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: [
                    'observe',
                    'desktop_state',
                    'list_windows',
                    'list_apps',
                    'click',
                    'double_click',
                    'right_click',
                    'drag',
                    'type',
                    'key',
                    'hotkey',
                    'scroll',
                    'set_value',
                    'invoke_menu',
                    'bring_to_front',
                    'set_window_frame',
                    'verify_state',
                    'zoom',
                    'clipboard_read',
                    'clipboard_write',
                    'parse_visual_regions',
                    'screen_size',
                    'cursor_position',
                    'guide',
                    'launch',
                    'list_tools',
                    'describe_tool',
                    'call',
                    'run_steps',
                    'run_script',
                ],
                description: 'Desktop action to perform',
            },
            tool: {
                type: 'string',
                description:
                    'Native driver tool name for call or describe_tool; discover with list_tools.',
            },
            arguments: {
                type: 'object',
                additionalProperties: true,
                description:
                    'Arguments for any action. For call put tool at the top level and its native arguments here. run_steps accepts an ordered steps array here or at the top level. It permits only input actions; perform window activation, launch and resizing in separate calls before batching.',
            },
            pid: {
                type: 'number',
                description: 'Target process id from list_windows or list_apps',
            },
            window_id: {
                type: 'number',
                description: 'Exact target window id from list_windows or launch',
            },
            app: {
                type: 'string',
                description:
                    'Application name; used to filter list_windows or select an app for launch',
            },
            element_token: {
                type: 'string',
                description: 'Element token from the latest observe of this window',
            },
            x: {
                type: 'number',
                description:
                    'Window-local screenshot X. For click/type/key/scroll it targets a pixel; for set_window_frame it is the desktop X',
            },
            y: {
                type: 'number',
                description:
                    'Window-local screenshot Y. For click/type/key/scroll it targets a pixel; for set_window_frame it is the desktop Y',
            },
            x1: {
                type: 'number',
                description: 'Zoom region left edge in observe screenshot pixels',
            },
            y1: {
                type: 'number',
                description: 'Zoom region top edge in observe screenshot pixels',
            },
            x2: {
                type: 'number',
                description: 'Zoom region right edge in observe screenshot pixels',
            },
            y2: {
                type: 'number',
                description: 'Zoom region bottom edge in observe screenshot pixels',
            },
            from_x: { type: 'number', description: 'Drag start X in window screenshot pixels' },
            from_y: { type: 'number', description: 'Drag start Y in window screenshot pixels' },
            to_x: { type: 'number', description: 'Drag end X in window screenshot pixels' },
            to_y: { type: 'number', description: 'Drag end Y in window screenshot pixels' },
            width: { type: 'number', description: 'New window width for set_window_frame' },
            height: { type: 'number', description: 'New window height for set_window_frame' },
            button: {
                type: 'string',
                enum: ['left', 'right', 'middle'],
                description: 'Mouse button for click or drag; defaults to left',
            },
            count: {
                type: 'number',
                description: 'Click count 1-3; use 2 for double-click',
            },
            scope: {
                type: 'string',
                enum: ['window', 'desktop'],
                description:
                    'Coordinate scope. Desktop scope targets the current foreground desktop and requires foreground permission',
            },
            capture_id: {
                type: 'string',
                description:
                    'Immutable capture id from observe or desktop_state; use it for exact pixels or visual-region parsing',
            },
            from_zoom: {
                type: 'boolean',
                description: 'Treat pointer coordinates as pixels from the last zoom image',
            },
            modifier: {
                type: 'array',
                items: { type: 'string' },
                description: 'Modifier keys held during a pointer action, for example ["ctrl"]',
            },
            element_action: {
                type: 'string',
                enum: ['expand'],
                description: 'Use expand to open a UIA split-button or dropdown element',
            },
            text: {
                type: 'string',
                description: 'Text to type or clipboard text to write',
            },
            delay_ms: {
                type: 'number',
                description: 'Delay between typed characters, 0-200 ms',
            },
            key: {
                type: 'string',
                description: 'Key name, for example Enter, Tab, or s',
            },
            modifiers: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'Modifier keys for press_key, for example ["Ctrl"]. Requires foreground access',
            },
            keys: {
                type: 'array',
                items: { type: 'string' },
                description: 'Hotkey combination ending in one key, for example ["ctrl", "c"]',
            },
            direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
            amount: { type: 'number', description: 'Scroll amount' },
            by: {
                type: 'string',
                enum: ['line', 'page'],
                description: 'Scroll granularity; defaults to line',
            },
            duration_ms: {
                type: 'number',
                description: 'Drag duration from 0-10000 ms',
            },
            steps: {
                anyOf: [
                    { type: 'number' },
                    { type: 'array', items: { type: 'object', additionalProperties: true } },
                ],
                description:
                    'Drag interpolation count (1-200), or ordered input steps for run_steps',
            },
            value: {
                type: 'string',
                description: 'Value to set through UIA ValuePattern; prefer element_token',
            },
            menu_path: {
                type: 'array',
                items: { type: 'string' },
                description: 'Exact application menu path, for example ["File", "Save As..."]',
            },
            expect: {
                type: 'array',
                items: { type: 'object' },
                description: 'Bounded window or element predicates for verify_state',
            },
            stable_samples: {
                type: 'number',
                description: 'Consecutive satisfied verify_state samples, 1-5',
            },
            timeout_ms: {
                type: 'number',
                description: 'Timeout for observe or verify_state in milliseconds',
            },
            query: {
                type: 'string',
                description: 'Case-insensitive substring projection for observe',
            },
            tree_format: {
                type: 'string',
                enum: ['markdown', 'elements', 'both'],
                description: 'Accessibility tree format for observe',
            },
            max_elements: {
                type: 'number',
                description: 'Maximum UIA elements walked by observe',
            },
            max_depth: {
                type: 'number',
                description: 'Maximum UIA tree depth walked by observe',
            },
            include_screenshot: {
                type: 'boolean',
                description: 'Return window pixels with observe or verify_state',
            },
            include_accessibility_tree: {
                type: 'boolean',
                description: 'Set false for a screenshot-only observe',
            },
            display_only: {
                type: 'boolean',
                description: 'Return pixels for display without registering an action capture',
            },
            since: {
                type: 'string',
                description: 'Previous observe snapshot id; returns only the diff',
            },
            full_output: {
                type: 'boolean',
                description: 'Return the full observe response instead of the compact projection',
            },
            verbose: {
                type: 'boolean',
                description: 'Include driver notes in observe output',
            },
            max_image_dimension: {
                type: 'number',
                description: 'Long-edge screenshot cap in pixels; 0 keeps native resolution',
            },
            max_dimension: {
                type: 'number',
                description: 'Legacy per-call screenshot cap',
            },
            include_text: {
                type: 'boolean',
                description: 'Return privacy-sensitive plain clipboard text',
            },
            image_path: {
                type: 'string',
                description: 'Absolute local image path to place on the clipboard',
            },
            file_path: {
                type: 'string',
                description: 'Absolute local file path to place on the clipboard as a file URL',
            },
            kinds: {
                type: 'array',
                items: { type: 'string', enum: ['text', 'icon'] },
                description: 'Visual region kinds to return',
            },
            max_regions: {
                type: 'number',
                description: 'Maximum visual regions to return',
            },
            min_confidence: {
                type: 'number',
                description: 'Minimum visual-region confidence from 0 to 1',
            },
            topic: {
                type: 'string',
                description:
                    'Guide topic: overview, drag, browser, permissions, batching, or menus',
            },
            path: { type: 'string', description: 'Executable path for launch' },
            start_minimized: {
                type: 'boolean',
                description:
                    'Launch without stealing focus; required with path when TouchAI runs elevated',
            },
            aumid: { type: 'string', description: 'Application user model id for launch' },
            bundle_id: { type: 'string', description: 'Bundle id for launch' },
            launch_path: { type: 'string', description: 'Alias for path accepted by the driver' },
            urls: {
                type: 'array',
                items: { type: 'string' },
                description: 'URLs to open with launch',
            },
            additional_arguments: {
                type: 'array',
                items: { type: 'string' },
                description: 'Extra command-line arguments for launch',
            },
            on_screen_only: {
                type: 'boolean',
                description: 'Only return windows currently on screen',
            },
            foreground: {
                type: 'boolean',
                description:
                    'Escalate this action to the foreground. Requires the foreground permissions switch',
            },
        },
        required: ['action'],
    };

    override async buildToolDefinition(
        namespacedName: string,
        config: ComputerUseConfig
    ): Promise<AiToolDefinition> {
        const definition = await super.buildToolDefinition(namespacedName, config);
        const groups = await computerUseService.loadGroups();
        const tools = (await computerUseService.listTools()).filter(
            (tool) => !disabledToolGroup(tool.name, groups)
        );
        if ((await computerUseService.loadDriver()) === 'agent-desktop') {
            return {
                ...definition,
                description: `${AGENT_DESKTOP_INSTRUCTIONS}\nEnabled tools: ${tools.map((tool) => tool.name).join(', ') || 'Install agent-desktop in Computer control settings.'}`,
                input_schema: {
                    type: 'object',
                    properties: {
                        action: {
                            type: 'string',
                            enum: [
                                'call',
                                'list_tools',
                                'describe_tool',
                                ...tools.map((tool) => tool.name),
                            ],
                        },
                        tool: {
                            type: 'string',
                            ...(tools.length ? { enum: tools.map((tool) => tool.name) } : {}),
                        },
                        arguments: { type: 'object', additionalProperties: true },
                    },
                    required: ['action'],
                },
            };
        }
        return {
            ...definition,
            description: `${definition.description}\nEnabled native tools: ${tools.map((tool) => tool.name).join(', ') || 'Driver not loaded; install it in Computer use settings.'}`,
            input_schema: {
                ...this.inputSchema,
                properties: {
                    ...this.inputSchema.properties,
                    action: {
                        type: 'string',
                        enum: [
                            ...new Set([
                                ...Object.keys(DRIVER_TOOL).filter(
                                    (action) =>
                                        action === 'call' ||
                                        !disabledToolGroup(
                                            DRIVER_TOOL[action as ComputerAction],
                                            groups
                                        )
                                ),
                                'list_tools',
                                'describe_tool',
                                ...tools.map((tool) => tool.name),
                            ]),
                        ],
                    },
                    tool: {
                        type: 'string',
                        ...(tools.length ? { enum: tools.map((tool) => tool.name) } : {}),
                    },
                },
            },
        };
    }

    override parseConfig(configJson: string | null): ComputerUseConfig {
        if (!configJson) return this.defaultConfig;
        try {
            const parsed = JSON.parse(configJson) as Partial<ComputerUseConfig>;
            return { allowForeground: parsed.allowForeground === true };
        } catch {
            return this.defaultConfig;
        }
    }

    override async buildApprovalRequest(
        args: Record<string, unknown>,
        _config: ComputerUseConfig
    ): Promise<ToolApprovalRequest | null> {
        void _config;
        try {
            args = await normalizeRequest(args);
        } catch {
            return null;
        }
        if (args.action === 'call' || args.action === 'run_steps' || args.action === 'run_script') {
            return computerUseService.loadSettings().then((settings) =>
                settings.approval === 'full-access'
                    ? null
                    : {
                          title: tt('电脑操作确认'),
                          description: tt('将对这个桌面目标执行一次操作'),
                          command: `${String(args.tool ?? args.action)} ${JSON.stringify(args.arguments ?? {})}`,
                          riskLabel: '',
                          reason: tt('桌面操作会真实影响你的应用'),
                          commandLabel: '',
                          approveLabel: tt('批准'),
                          rejectLabel: tt('拒绝'),
                          enterHint: 'Enter',
                          escHint: 'Esc',
                      }
            );
        }
        const action = normalizeAction(args.action);
        if (!action || !REQUIRES_APPROVAL.has(action)) return null;

        const key = targetKey(args.pid, args.window_id);
        const targeted = isTargeted(args);
        const wantsForeground = requiresForeground(action, args);

        return computerUseService.loadSettings().then((settings) => {
            if (wantsForeground && !isForegroundAllowed(settings)) {
                return null;
            }
            if (settings.approval === 'full-access') {
                return null;
            }
            if (
                !wantsForeground &&
                action !== 'launch' &&
                targeted &&
                settings.approval === 'session-window' &&
                computerUseService.isAllowedForSession(key)
            ) {
                return null;
            }

            const target =
                typeof args.pid === 'number'
                    ? `pid ${args.pid}`
                    : String(args.path ?? args.app ?? 'desktop');
            const detail = describeActionDetail(action, args);

            return {
                title: tt('电脑操作确认'),
                description: tt('将对这个桌面目标执行一次操作'),
                command: truncateText(`${action} ${target} ${detail}`.trim(), 180),
                riskLabel: '',
                reason: wantsForeground
                    ? tt('前台升级会抢走焦点，需要单独确认')
                    : tt('桌面操作会真实影响你的应用'),
                commandLabel: '',
                approveLabel: tt('批准'),
                rejectLabel: tt('拒绝'),
                enterHint: 'Enter',
                escHint: 'Esc',
            } satisfies ToolApprovalRequest;
        });
    }

    async execute(
        args: Record<string, unknown>,
        _config: ComputerUseConfig,
        context: BaseBuiltInToolExecutionContext
    ): Promise<BuiltInToolExecutionResult> {
        if (!(await computerUseService.isEnabled())) return failure('computer_use_disabled');
        if (context.signal?.aborted) return failure('computer use cancelled', 'timeout');
        try {
            args = await normalizeRequest(args);
        } catch (error) {
            return failure(error instanceof Error ? error.message : String(error));
        }
        const groups = await computerUseService.loadGroups();
        if (args.action === 'list_tools' || args.action === 'describe_tool') {
            const catalog = await computerUseService.listTools();
            const tools = catalog.filter((entry) => !disabledToolGroup(entry.name, groups));
            const output =
                args.action === 'describe_tool'
                    ? tools.find((entry) => entry.name === args.tool)
                    : tools.map((entry) => ({
                          name: entry.name,
                          group: toolGroup(entry.name),
                          description: entry.description.split('\n')[0]?.slice(0, 240),
                          required: entry.inputSchema.required,
                      }));
            return output
                ? { result: JSON.stringify(output), isError: false, status: 'success' }
                : failure('unknown_or_disabled_driver_tool');
        }
        const action = normalizeAction(args.action);
        if (!action) {
            return {
                result: 'unsupported action',
                isError: true,
                status: 'error',
                errorMessage: 'unsupported action',
            };
        }

        const nativeCall = action === 'call' || action === 'run_steps' || action === 'run_script';
        const nativeTool =
            action === 'call'
                ? String(args.tool ?? '')
                : action === 'observe' && !isTargeted(args)
                  ? 'list_windows'
                  : DRIVER_TOOL[action];
        const disabledGroup = disabledToolGroup(nativeTool, groups);
        if (disabledGroup) return failure(`tool_group_disabled:${disabledGroup}`);
        const nativeDefinition = nativeCall
            ? (await computerUseService.listTools()).find((entry) => entry.name === nativeTool)
            : undefined;
        if (nativeCall && !nativeDefinition) return failure('unknown_driver_tool');
        if (nativeCall && !isRecord(args.arguments))
            return failure('native_arguments_must_be_an_object');
        const nativeArgs = nativeCall ? (args.arguments as Record<string, unknown>) : args;
        if (nativeTool === 'desktop_batch') {
            const error = agentDesktopBatchError(nativeArgs, groups);
            if (error) return failure(error);
        }

        if (action === 'hotkey') {
            const hotkeyError = validateHotkey(args);
            if (hotkeyError) {
                return {
                    result: hotkeyError,
                    isError: true,
                    status: 'error',
                    errorMessage: 'invalid_arguments',
                };
            }
        }

        const settings = await computerUseService.loadSettings();
        if (nativeTool.startsWith('desktop_') && settings.allowedApps.length > 0) {
            if (!isAppAllowed(settings, nativeArgs)) return failure('app_not_allowed');
            if (nativeTool === 'desktop_batch')
                return failure('app_scope_cannot_be_enforced_for_batch');
        }
        if (action === 'launch' && !isAppAllowed(settings, args)) {
            return {
                result: 'app_not_allowed',
                isError: true,
                status: 'error',
                errorMessage: 'app_not_allowed',
            };
        }
        const supportsImages = context.currentModel
            ? getModelAttachmentCapabilities(context.currentModel).supportsImages
            : false;
        let nativeInvocation: ReturnType<typeof normalizeNativeInput> | null = null;
        try {
            if (nativeCall)
                nativeInvocation = normalizeNativeInput(nativeTool, nativeArgs, supportsImages);
        } catch (error) {
            return failure(error instanceof Error ? error.message : String(error));
        }
        const effectiveArgs = nativeInvocation?.args ?? { ...nativeArgs };
        if (nativeCall) {
            if (['run_script', 'replay_trajectory'].includes(nativeTool)) {
                if (settings.approval !== 'full-access') return failure('full_access_required');
                if (settings.allowedApps.length > 0)
                    return failure('app_scope_cannot_be_enforced_for_script_or_replay');
                if (!settings.allowForeground) return failure('foreground_not_allowed');
            }
            if (
                nativeTool === 'launch_app' &&
                !isAppAllowed(settings, { ...effectiveArgs, app: effectiveArgs.name })
            )
                return failure('app_not_allowed');
            if (
                nativeTool === 'browser_prepare' &&
                settings.allowedApps.length > 0 &&
                effectiveArgs.allow_launch !== false
            )
                return failure('app_not_allowed');
            if (!settings.allowForeground && nativeNeedsForeground(nativeTool, effectiveArgs))
                return failure('foreground_not_allowed');
            if (
                ['type_text', 'press_key', 'scroll', 'run_steps'].includes(nativeTool) &&
                effectiveArgs.delivery_mode === undefined
            ) {
                effectiveArgs.delivery_mode =
                    settings.approval === 'full-access' && settings.allowForeground
                        ? 'foreground'
                        : 'background';
            }
        }
        if (
            settings.approval === 'full-access' &&
            settings.allowForeground &&
            effectiveArgs.foreground === undefined &&
            (action === 'type' || action === 'key' || action === 'scroll')
        ) {
            effectiveArgs.foreground = true;
        }
        const imagesUnavailable = !supportsImages && nativeArgs.include_screenshot === true;
        if (imagesUnavailable && (action === 'observe' || action === 'verify_state')) {
            effectiveArgs.include_screenshot = false;
            if (action === 'observe') effectiveArgs.include_accessibility_tree = true;
        }
        if (requiresForeground(action, effectiveArgs)) {
            effectiveArgs.foreground = true;
        }
        const foregroundEscalated = nativeCall
            ? nativeNeedsForeground(nativeTool, effectiveArgs)
            : requiresForeground(action, effectiveArgs);
        if (foregroundEscalated && !isForegroundAllowed(settings)) {
            return {
                result: 'foreground_not_allowed',
                isError: true,
                status: 'error',
                errorMessage: 'foreground_not_allowed',
            };
        }

        const key = targetKey(effectiveArgs.pid, effectiveArgs.window_id);
        const hasTarget = isTargeted(effectiveArgs);
        const driverTool =
            action === 'observe' && !hasTarget
                ? 'list_windows'
                : action === 'hotkey' &&
                    effectiveArgs.x === undefined &&
                    effectiveArgs.y === undefined &&
                    Array.isArray(effectiveArgs.keys)
                  ? 'press_key'
                  : (nativeInvocation?.tool ?? nativeTool);
        const driverArgs =
            action === 'observe' && !hasTarget
                ? {}
                : (nativeInvocation?.args ?? pickArgs(action, effectiveArgs));
        const mutating = nativeCall
            ? nativeDefinition?.annotations?.readOnlyHint !== true
            : MUTATING.has(action);

        if (context.signal?.aborted) return failure('computer use cancelled', 'timeout');
        if (context.signal) {
            void computerUseService.startActivity(context.signal).catch((error) => {
                log.warn('[ComputerUse] Activity feedback failed:', error);
            });
        } else if (mutating) {
            void computerUseService.pulseGlow().catch((error) => {
                log.warn('[ComputerUse] Activity feedback failed:', error);
            });
        }

        let invocation = context.signal
            ? computerUseService.execute(driverTool, driverArgs, context.signal)
            : computerUseService.execute(driverTool, driverArgs);

        let aborted = false;
        const onAbort = (): void => {
            aborted = true;
            void invocation.cancel();
        };
        context.signal?.addEventListener('abort', onAbort);

        try {
            if (context.signal?.aborted) onAbort();
            const envelope = await invocation.result;
            if (aborted) throw new Error('computer use cancelled');
            const payload = isRecord(envelope.structuredContent) ? envelope.structuredContent : {};
            const agentData = isRecord(payload.data) ? payload.data : {};
            const batchFailed =
                nativeTool === 'desktop_batch' &&
                (Number(agentData.not_started_entries ?? 0) > 0 ||
                    (Array.isArray(agentData.results) &&
                        agentData.results.some(
                            (entry: unknown) => !isRecord(entry) || entry.ok !== true
                        )));
            const driverSucceeded =
                envelope['isError'] !== true &&
                payload.ok !== false &&
                payload.status !== 'refused' &&
                !isRecord(payload.refusal) &&
                !batchFailed;
            const delivery = isRecord(agentData.disposition)
                ? agentData.disposition.delivery
                : undefined;
            const effect =
                readStructuredField(envelope, 'effect') ??
                (delivery === 'delivered_unverified' ? 'unverifiable' : undefined);
            const effectUnconfirmed =
                driverSucceeded &&
                mutating &&
                (effect === 'unverifiable' || effect === 'suspected_noop');
            let text = extractText(envelope);
            if (
                nativeTool === 'get_window_state' &&
                effectiveArgs.tree_format === 'elements' &&
                Array.isArray(payload.elements) &&
                text !== JSON.stringify(payload)
            ) {
                text += `\nWindow elements: ${truncateText(JSON.stringify({ snapshot_id: payload.snapshot_id, elements: payload.elements }), 32000)}`;
            }
            if (
                nativeCall &&
                nativeTool !== 'get_window_state' &&
                Object.keys(payload).length > 0
            ) {
                const formatted = formatDriverPayload(nativeTool, payload);
                text =
                    nativeTool.startsWith('desktop_') || text === JSON.stringify(payload)
                        ? formatted
                        : `${text}\nDriver result: ${formatted}`;
            }
            if (!driverSucceeded && nativeDefinition) {
                text += `\nInput schema for ${nativeTool}: ${JSON.stringify(nativeDefinition.inputSchema)}`;
            }
            if (
                driverSucceeded &&
                nativeTool === 'get_browser_state' &&
                payload.mode === 'bind' &&
                payload.binding_quality === 'exact' &&
                typeof payload.target_id === 'string' &&
                Array.isArray(payload.tabs)
            ) {
                const activeTabs = payload.tabs.filter(
                    (tab: unknown) => isRecord(tab) && tab.active === true
                );
                const activeTab: unknown = activeTabs.length === 1 ? activeTabs[0] : undefined;
                if (isRecord(activeTab) && typeof activeTab.tab_id === 'string') {
                    const nextRead = {
                        action: 'call',
                        tool: 'get_browser_state',
                        arguments: compactArgs({
                            target_id: payload.target_id,
                            tab_id: activeTab.tab_id,
                            session: effectiveArgs.session,
                        }),
                    };
                    text += `\nNext browser read: ${JSON.stringify(nextRead)}. This returns the page DOM and live refs. Use this attached browser surface; legacy page queries may only return Windows accessibility labels without image URLs.`;
                }
            }
            if (driverSucceeded && settings.cursorVisible && mutating) {
                const pointer = reportedPointer(envelope);
                if (pointer) {
                    void computerUseService.pulseGlow(pointer, context.signal).catch((error) => {
                        log.warn('[ComputerUse] Pointer feedback failed:', error);
                    });
                }
            }
            if (!driverSucceeded && action === 'set_value' && /ValuePattern/i.test(text)) {
                text +=
                    '\nDo not retry set_value on this control. Use click to focus it, then type; for replacement use hotkey ["ctrl","a"] before type when foreground access is enabled.';
            }
            let imageEnvelope = envelope;
            if (action === 'clipboard_read' && effectiveArgs.include_text === true) {
                const clipboardText = readStructuredField(envelope, 'text');
                if (clipboardText !== undefined)
                    text += `\nClipboard text: ${JSON.stringify(clipboardText)}`;
            }
            if (effectUnconfirmed) {
                text += `\neffect=${effect}; input was delivered but the intended outcome is not confirmed. Do not repeat the action without checking the current state.`;
                if (hasTarget && !nativeCall && !disabledToolGroup('get_window_state', groups)) {
                    const refreshPixels =
                        supportsImages &&
                        (effectiveArgs.x !== undefined ||
                            effectiveArgs.from_x !== undefined ||
                            action === 'scroll');
                    try {
                        invocation = computerUseService.execute('get_window_state', {
                            pid: effectiveArgs.pid,
                            window_id: effectiveArgs.window_id,
                            include_screenshot: refreshPixels,
                            timeout_ms: 3000,
                        });
                        const observation = await invocation.result;
                        if (observation['isError'] === true) {
                            text += `\nFollow-up observation failed: ${extractText(observation)}; observe the target before retrying.`;
                        } else {
                            text += `\nCurrent window state after the action (use these fresh element tokens):\n${extractText(observation)}`;
                            imageEnvelope = observation;
                            if (!refreshPixels && supportsImages) {
                                text +=
                                    '\nThis observation is accessibility-only; take a fresh screenshot before pixel actions.';
                            }
                        }
                    } catch (error) {
                        text += `\nFollow-up observation failed: ${String(error)}; observe the target before retrying.`;
                    }
                } else if (!nativeCall) {
                    text += '\nNo window target was provided; observe the target before retrying.';
                }
            }
            const imageContent: McpToolContent[] = Array.isArray(imageEnvelope.content)
                ? imageEnvelope.content.flatMap((item) => {
                      if (!item || item.type !== 'image' || typeof item.data !== 'string')
                          return [];
                      return [
                          {
                              type: 'image' as const,
                              data: item.data,
                              mime_type: item.mimeType ?? item.mime_type ?? 'image/png',
                          },
                      ];
                  })
                : [];
            let attachments: AttachmentIndex[] | undefined;
            if (imageContent.length > 0 && supportsImages) {
                attachments = await extractMcpToolAttachments(
                    { content: imageContent, success: driverSucceeded, is_error: !driverSucceeded },
                    { toolCallId: context.callId, toolName: 'computer_use' }
                );
                text +=
                    '\nScreenshot pixels are attached. Use screenshot coordinates and capture_id for pixel actions.';
            } else if (imagesUnavailable || imageContent.length > 0) {
                text +=
                    '\nThe current model does not support images. Use observe with include_accessibility_tree=true; do not repeat screenshot requests or guess pixel coordinates.';
            }
            const observation = isRecord(payload.observation) ? payload.observation : {};
            const structured = isRecord(observation.state)
                ? observation.state
                : imageEnvelope.structuredContent;
            if (structured && typeof structured === 'object') {
                const metadata = compactArgs(
                    Object.fromEntries(
                        [
                            'capture_id',
                            'snapshot_id',
                            'screenshot_width',
                            'screenshot_height',
                            'window_bounds',
                        ].map((key) => [key, (structured as Record<string, unknown>)[key]])
                    )
                );
                if (Object.keys(metadata).length > 0)
                    text += `\nCapture metadata: ${JSON.stringify(metadata)}`;
            }
            if (aborted) throw new Error('computer use cancelled');
            if (
                driverSucceeded &&
                !effectUnconfirmed &&
                MUTATING.has(action) &&
                action !== 'launch' &&
                !nativeCall &&
                hasTarget &&
                settings.approval === 'session-window'
            ) {
                computerUseService.allowForSession(key);
            }
            return {
                result: text,
                attachments,
                isError: !driverSucceeded,
                status: driverSucceeded ? 'success' : 'error',
                structuredPayload: {
                    action: nativeCall ? nativeTool : action,
                    effect,
                    kind: 'computer_use',
                    pid: typeof effectiveArgs.pid === 'number' ? effectiveArgs.pid : undefined,
                    route: readStructuredField(envelope, 'route'),
                    windowId:
                        typeof effectiveArgs.window_id === 'number'
                            ? effectiveArgs.window_id
                            : undefined,
                },
            };
        } catch (error) {
            return {
                result: aborted ? tt('已取消') : String(error),
                isError: true,
                status: aborted ? 'timeout' : 'error',
                errorMessage: String(error),
            };
        } finally {
            context.signal?.removeEventListener('abort', onAbort);
        }
    }
}

function readStructuredField(envelope: Record<string, unknown>, field: string): string | undefined {
    const structured = envelope['structuredContent'];
    if (!structured || typeof structured !== 'object') return undefined;
    const value = (structured as Record<string, unknown>)[field];
    return typeof value === 'string' ? value : undefined;
}

function extractText(envelope: Record<string, unknown>): string {
    const content = envelope['content'];
    if (Array.isArray(content)) {
        const parts = content
            .map((item) =>
                item && typeof item === 'object' && 'text' in item
                    ? String((item as { text?: unknown }).text ?? '')
                    : ''
            )
            .filter(Boolean);
        if (parts.length > 0) return parts.join('\n');
    }
    const structured = envelope['structuredContent'];
    return structured ? JSON.stringify(structured) : '{}';
}

function failure(
    message: string,
    status: 'error' | 'timeout' = 'error'
): BuiltInToolExecutionResult {
    return { result: message, isError: true, status, errorMessage: message };
}

function formatDriverPayload(tool: string, payload: Record<string, unknown>): string {
    if (
        tool === 'get_browser_state' &&
        isRecord(payload.snapshot) &&
        payload.snapshot.format === 'semantic_v2'
    ) {
        const {
            status,
            mode,
            target_id,
            tab_id,
            page,
            snapshot,
            refs,
            content_refs,
            outline,
            ...rest
        } = payload;
        payload = {
            status,
            mode,
            target_id,
            tab_id,
            page,
            snapshot,
            refs,
            content_refs,
            outline,
            ...rest,
        };
    }
    return truncateText(JSON.stringify(payload), 32000);
}

function nativeNeedsForeground(tool: string, args: Record<string, unknown>): boolean {
    if (tool.startsWith('desktop_')) {
        return (
            ['input', 'windows', 'automation'].includes(toolGroup(tool)) &&
            !['desktop_list_apps', 'desktop_list_windows'].includes(tool)
        );
    }
    if (['bring_to_front', 'run_script', 'replay_trajectory'].includes(tool)) return true;
    if (
        args.delivery_mode === 'foreground' ||
        args.foreground_fallback === true ||
        args.scope === 'desktop'
    )
        return true;
    if (
        tool === 'hotkey' ||
        (tool === 'press_key' && Array.isArray(args.modifiers) && args.modifiers.length > 0)
    )
        return true;
    if (
        tool === 'type_text' &&
        typeof args.text === 'string' &&
        /[\u{10000}-\u{10FFFF}]/u.test(args.text)
    )
        return true;
    if (tool === 'browser_prepare' && args.allow_launch !== false) return true;
    if (tool === 'run_steps' && Array.isArray(args.steps)) {
        return args.steps.some((step: unknown) => {
            if (!isRecord(step)) return false;
            if (typeof step.tool === 'string')
                return nativeNeedsForeground(step.tool, isRecord(step.args) ? step.args : {});
            return Object.entries(step).some(
                ([name, value]) => isRecord(value) && nativeNeedsForeground(name, value)
            );
        });
    }
    return false;
}

function normalizeNativeInput(
    tool: string,
    input: Record<string, unknown>,
    supportsImages: boolean
): { tool: string; args: Record<string, unknown> } {
    if (tool.startsWith('desktop_')) {
        return {
            tool,
            args: tool === 'desktop_batch' ? { stop_on_error: true, ...input } : { ...input },
        };
    }
    const args = { ...input };
    if (args.foreground !== undefined) {
        if (typeof args.foreground !== 'boolean') throw new Error('foreground_must_be_a_boolean');
        const delivery = args.foreground ? 'foreground' : 'background';
        if (args.delivery_mode !== undefined && args.delivery_mode !== delivery)
            throw new Error('conflicting_argument:delivery_mode; provide one delivery preference');
        args.delivery_mode = delivery;
        delete args.foreground;
    }
    if (
        tool === 'get_browser_state' &&
        typeof args.target_id === 'string' &&
        typeof args.tab_id === 'string' &&
        args.snapshot_format === undefined
    ) {
        args.snapshot_format = 'semantic_v2';
    }
    if (tool === 'run_steps') {
        if (Array.isArray(args.steps)) {
            args.steps = args.steps.map((step) => {
                if (!isRecord(step)) return step;
                if (typeof step.tool === 'string') {
                    const normalized = normalizeNativeInput(
                        step.tool,
                        isRecord(step.args) ? step.args : {},
                        supportsImages
                    );
                    return { ...step, tool: normalized.tool, args: normalized.args };
                }
                return Object.fromEntries(
                    Object.entries(step).map(([name, value]) => {
                        if (!isRecord(value) || ['wait_for', 'expect'].includes(name))
                            return [name, value];
                        const normalized = normalizeNativeInput(name, value, supportsImages);
                        return [normalized.tool, normalized.args];
                    })
                );
            });
        }
        if (!supportsImages && isRecord(args.observe)) {
            args.observe = {
                ...args.observe,
                include_screenshot: false,
                include_accessibility_tree: true,
            };
        }
    }
    if (!supportsImages && ['get_window_state', 'verify_state'].includes(tool)) {
        args.include_screenshot = false;
        if (tool === 'get_window_state') args.include_accessibility_tree = true;
    }
    if (
        tool === 'hotkey' &&
        args.x === undefined &&
        args.y === undefined &&
        validateHotkey(args) === null
    ) {
        const keys = args.keys as string[];
        delete args.keys;
        args.key = keys[keys.length - 1];
        args.modifiers = keys.slice(0, -1);
        args.delivery_mode = 'foreground';
        return { tool: 'press_key', args };
    }
    if (
        (tool === 'type_text' &&
            typeof args.text === 'string' &&
            /[\u{10000}-\u{10FFFF}]/u.test(args.text)) ||
        (tool === 'press_key' && Array.isArray(args.modifiers) && args.modifiers.length > 0)
    ) {
        args.delivery_mode = 'foreground';
    }
    return { tool, args };
}

export const builtInTools: BuiltInToolGroup = [new ComputerUseTool()];
export { ComputerUseTool };
