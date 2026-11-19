export const COMPUTER_USE_GROUPS = [
    'observe',
    'windows',
    'input',
    'clipboard',
    'browser',
    'automation',
    'recording',
    'runtime',
] as const;

export type ComputerUseGroup = (typeof COMPUTER_USE_GROUPS)[number];
export type ComputerUseGroups = Partial<Record<ComputerUseGroup, boolean>>;

const GROUP_TOOLS: Record<ComputerUseGroup, readonly string[]> = {
    observe: [
        'get_window_state',
        'get_desktop_state',
        'get_screen_size',
        'get_cursor_position',
        'verify_state',
        'get_accessibility_tree',
        'zoom',
        'parse_visual_regions',
    ],
    windows: [
        'list_apps',
        'list_windows',
        'launch_app',
        'kill_app',
        'bring_to_front',
        'set_window_frame',
        'invoke_menu',
        'debug_window_info',
    ],
    input: [
        'click',
        'double_click',
        'right_click',
        'drag',
        'type_text',
        'press_key',
        'hotkey',
        'set_value',
        'scroll',
        'move_cursor',
    ],
    clipboard: ['clipboard_read', 'clipboard_write'],
    browser: [
        'page',
        'get_browser_state',
        'browser_prepare',
        'browser_navigate',
        'browser_click',
        'browser_type',
        'browser_select',
        'browser_dialog',
        'browser_set_input_files',
        'browser_download',
        'browser_pointer',
    ],
    automation: ['run_steps', 'run_script'],
    recording: [
        'start_recording',
        'stop_recording',
        'get_recording_state',
        'replay_trajectory',
        'install_ffmpeg',
    ],
    runtime: [
        'set_agent_cursor_enabled',
        'set_agent_cursor_motion',
        'get_agent_cursor_state',
        'set_agent_cursor_theme',
        'check_permissions',
        'health_report',
        'get_config',
        'set_config',
        'start_session',
        'escalate_session',
        'get_session',
        'list_sessions',
        'get_session_state',
        'end_session',
        'get_guide',
    ],
};

export function toolGroup(tool: string): ComputerUseGroup {
    if (tool.startsWith('desktop_')) {
        const action = tool.slice('desktop_'.length);
        if (action.startsWith('clipboard_')) return 'clipboard';
        if (action.startsWith('trace_')) return 'recording';
        if (action === 'batch') return 'automation';
        if (
            [
                'snapshot',
                'find',
                'screenshot',
                'get',
                'is',
                'wait',
                'list_displays',
                'list_surfaces',
                'list_notifications',
            ].includes(action)
        )
            return 'observe';
        if (
            [
                'list_windows',
                'list_apps',
                'launch',
                'close_app',
                'focus_window',
                'resize_window',
                'move_window',
                'minimize',
                'maximize',
                'restore',
                'open_system_surface',
                'dismiss_notification',
                'dismiss_all_notifications',
                'notification_action',
            ].includes(action)
        )
            return 'windows';
        if (
            [
                'click',
                'double_click',
                'triple_click',
                'right_click',
                'type',
                'set_value',
                'clear',
                'focus',
                'select',
                'toggle',
                'check',
                'uncheck',
                'expand',
                'collapse',
                'scroll',
                'scroll_to',
                'press',
                'key_down',
                'key_up',
                'hover',
                'drag',
                'mouse_move',
                'mouse_click',
                'mouse_down',
                'mouse_up',
                'mouse_wheel',
            ].includes(action)
        )
            return 'input';
        return 'runtime';
    }
    return COMPUTER_USE_GROUPS.find((group) => GROUP_TOOLS[group].includes(tool)) ?? 'runtime';
}

export function disabledToolGroup(
    tool: string,
    groups: ComputerUseGroups
): ComputerUseGroup | undefined {
    const dependencies: readonly ComputerUseGroup[] =
        tool === 'desktop_session_start' || tool === 'desktop_session_gc'
            ? ['runtime', 'recording']
            : tool === 'replay_trajectory'
              ? COMPUTER_USE_GROUPS
              : tool === 'run_steps' || tool === 'run_script'
                ? ['automation', 'input', 'observe', 'windows']
                : [toolGroup(tool)];
    return dependencies.find((group) => groups[group] === false);
}
