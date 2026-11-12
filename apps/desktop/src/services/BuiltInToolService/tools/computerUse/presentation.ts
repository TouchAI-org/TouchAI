import { type MessageKey, t } from '@/i18n';
import { truncateText } from '@/utils/text';

import type {
    BuiltInToolConversationPresentation,
    BuiltInToolConversationStatus,
} from '../../types';
import { normalizeComputerUseArguments } from './arguments';

const ACTION_KEYS: Record<string, MessageKey> = {
    list_apps: 'conversation.computerUse.listApps',
    list_windows: 'conversation.computerUse.listWindows',
    get_window_state: 'conversation.computerUse.observe',
    get_desktop_state: 'conversation.computerUse.desktop',
    get_accessibility_tree: 'conversation.computerUse.accessibility',
    verify_state: 'conversation.computerUse.verify',
    launch_app: 'conversation.computerUse.launch',
    kill_app: 'conversation.computerUse.closeApp',
    bring_to_front: 'conversation.computerUse.focus',
    set_window_frame: 'conversation.computerUse.windowFrame',
    invoke_menu: 'conversation.computerUse.menu',
    debug_window_info: 'conversation.computerUse.windowInfo',
    click: 'conversation.computerUse.click',
    double_click: 'conversation.computerUse.doubleClick',
    right_click: 'conversation.computerUse.rightClick',
    drag: 'conversation.computerUse.drag',
    type_text: 'conversation.computerUse.type',
    press_key: 'conversation.computerUse.key',
    hotkey: 'conversation.computerUse.hotkey',
    set_value: 'conversation.computerUse.setValue',
    scroll: 'conversation.computerUse.scroll',
    clipboard_read: 'conversation.computerUse.clipboardRead',
    clipboard_write: 'conversation.computerUse.clipboardWrite',
    get_screen_size: 'conversation.computerUse.screenSize',
    get_cursor_position: 'conversation.computerUse.cursorPosition',
    move_cursor: 'conversation.computerUse.moveCursor',
    set_agent_cursor_enabled: 'conversation.computerUse.cursorVisibility',
    set_agent_cursor_motion: 'conversation.computerUse.cursorMotion',
    get_agent_cursor_state: 'conversation.computerUse.cursorState',
    set_agent_cursor_theme: 'conversation.computerUse.cursorTheme',
    check_permissions: 'conversation.computerUse.permissions',
    health_report: 'conversation.computerUse.health',
    get_config: 'conversation.computerUse.readConfig',
    set_config: 'conversation.computerUse.updateConfig',
    zoom: 'conversation.computerUse.zoom',
    page: 'conversation.computerUse.page',
    get_browser_state: 'conversation.computerUse.browserState',
    browser_prepare: 'conversation.computerUse.browserPrepare',
    browser_navigate: 'conversation.computerUse.browserNavigate',
    browser_click: 'conversation.computerUse.browserClick',
    browser_type: 'conversation.computerUse.browserType',
    browser_select: 'conversation.computerUse.browserSelect',
    browser_dialog: 'conversation.computerUse.browserDialog',
    browser_set_input_files: 'conversation.computerUse.upload',
    browser_download: 'conversation.computerUse.download',
    browser_pointer: 'conversation.computerUse.browserPointer',
    start_recording: 'conversation.computerUse.startRecording',
    stop_recording: 'conversation.computerUse.stopRecording',
    get_recording_state: 'conversation.computerUse.recordingState',
    replay_trajectory: 'conversation.computerUse.replay',
    install_ffmpeg: 'conversation.computerUse.installRecorder',
    start_session: 'conversation.computerUse.startSession',
    escalate_session: 'conversation.computerUse.escalateSession',
    get_session: 'conversation.computerUse.sessionState',
    list_sessions: 'conversation.computerUse.listSessions',
    get_session_state: 'conversation.computerUse.sessionState',
    end_session: 'conversation.computerUse.endSession',
    get_guide: 'conversation.computerUse.guide',
    run_steps: 'conversation.computerUse.batch',
    run_script: 'conversation.computerUse.script',
    parse_visual_regions: 'conversation.computerUse.visualRegions',
    list_tools: 'conversation.computerUse.listTools',
    describe_tool: 'conversation.computerUse.describeTool',
};

const ALIASES: Record<string, string> = {
    observe: 'get_window_state',
    desktop_state: 'get_desktop_state',
    type: 'type_text',
    key: 'press_key',
    screen_size: 'get_screen_size',
    cursor_position: 'get_cursor_position',
    guide: 'get_guide',
    launch: 'launch_app',
    desktop_snapshot: 'get_window_state',
    desktop_screenshot: 'get_desktop_state',
    desktop_find: 'get_accessibility_tree',
    desktop_get: 'verify_state',
    desktop_is: 'verify_state',
    desktop_wait: 'verify_state',
    desktop_type: 'type_text',
    desktop_press: 'press_key',
    desktop_launch: 'launch_app',
    desktop_close_app: 'kill_app',
    desktop_focus_window: 'bring_to_front',
    desktop_focus: 'bring_to_front',
    desktop_move_window: 'set_window_frame',
    desktop_resize_window: 'set_window_frame',
    desktop_minimize: 'set_window_frame',
    desktop_maximize: 'set_window_frame',
    desktop_restore: 'set_window_frame',
    desktop_clipboard_get: 'clipboard_read',
    desktop_clipboard_set: 'clipboard_write',
    desktop_clipboard_clear: 'clipboard_write',
    desktop_mouse_move: 'move_cursor',
    desktop_mouse_click: 'click',
    desktop_mouse_wheel: 'scroll',
    desktop_batch: 'run_steps',
    desktop_status: 'health_report',
    desktop_permissions: 'check_permissions',
    desktop_skills_get: 'get_guide',
    desktop_session_start: 'start_session',
    desktop_session_end: 'end_session',
    desktop_session_list: 'list_sessions',
    desktop_trace_show: 'get_recording_state',
    desktop_cursor_overlay_enable: 'set_agent_cursor_enabled',
    desktop_cursor_overlay_disable: 'set_agent_cursor_enabled',
};

const STATUS_KEYS: Record<BuiltInToolConversationStatus, MessageKey> = {
    executing: 'conversation.computerUse.executing',
    completed: 'conversation.computerUse.completed',
    error: 'conversation.computerUse.error',
    awaiting_approval: 'conversation.computerUse.awaitingApproval',
    rejected: 'conversation.computerUse.rejected',
    cancelled: 'conversation.computerUse.cancelled',
};

const POINTER_ACTIONS = new Set(['click', 'double_click', 'right_click', 'move_cursor']);

function coordinate(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined;
}

function point(x: unknown, y: unknown): string | undefined {
    const left = coordinate(x);
    const top = coordinate(y);
    return left === undefined || top === undefined ? undefined : `${left}, ${top}`;
}

export function buildComputerUsePresentation(
    outer: Record<string, unknown>,
    status: BuiltInToolConversationStatus
): BuiltInToolConversationPresentation {
    try {
        outer = normalizeComputerUseArguments(outer);
    } catch {
        outer = { action: outer.action };
    }
    const requested = String(outer.action === 'call' ? (outer.tool ?? '') : (outer.action ?? ''));
    const action = ALIASES[requested] ?? requested.replace(/^desktop_/, '');
    const operation = t(ACTION_KEYS[action] ?? 'settings.nav.computerUse.label');
    const args =
        outer.arguments && typeof outer.arguments === 'object' && !Array.isArray(outer.arguments)
            ? (outer.arguments as Record<string, unknown>)
            : outer;
    const target = [args.app, args.window, args.name].find(
        (value) => typeof value === 'string' && value.trim()
    );
    const details: string[] = [];
    if (typeof target === 'string') details.push(truncateText(target, 80));
    // Process and window identifiers are internal routing details. Showing them
    // reads as noise, so only human-meaningful targets are surfaced.
    const position = point(args.x, args.y);
    if (POINTER_ACTIONS.has(action) && position) details.push(position);
    if (action === 'drag') {
        const origin = point(args.from_x, args.from_y);
        const destination = point(args.to_x, args.to_y);
        if (origin && destination) details.push(`${origin} → ${destination}`);
    }
    if (action === 'browser_navigate' && typeof args.url === 'string') {
        details.push(truncateText(args.url, 80));
    }
    if (action === 'run_steps' && Array.isArray(args.steps)) {
        details.push(t('conversation.computerUse.stepCount', { count: args.steps.length }));
    }
    if (action === 'hotkey' || action === 'press_key') {
        const keys = Array.isArray(args.keys)
            ? args.keys
            : [...(Array.isArray(args.modifiers) ? args.modifiers : []), args.key];
        const combination = keys.filter((key) => typeof key === 'string').join('+');
        if (combination) details.push(truncateText(combination, 80));
    }
    return {
        verb: t(STATUS_KEYS[status], { operation }),
        content: details.join(' · '),
    };
}
