import {
    type ComputerUseGroups,
    disabledToolGroup,
} from '@services/ComputerUseService/capabilities';

import { isRecord } from './arguments';

export const AGENT_DESKTOP_INSTRUCTIONS =
    'Control desktop apps with agent-desktop. Use action="list_tools" to discover enabled tools and action="describe_tool", tool=<name> for exact schemas. ' +
    'Call action=<desktop_native_name> with arguments=<native arguments>, or action="call", tool=<name>, arguments={...}. ' +
    'Start with desktop_list_windows; use the returned app/window_id and desktop_snapshot to get qualified ref_id values such as @s123:e1. ' +
    'Read desktop_skills_get with name="desktop" and name="platform" for platform constraints. ' +
    'Inspect available_actions before acting. For a dropdown with only SetValue/SetFocus, use focus then targeted press (home/down/return) in one batch and verify its final value; desktop_select requires Select or Click support. Use compact/interactive_only snapshots when only controls are needed. ' +
    'Use ref_id, not cua element_token or screenshot-local coordinates. Coordinates for mouse tools are absolute screen coordinates. ' +
    'For known sequential actions use desktop_batch with commands_json=JSON.stringify([{command:"click",args:{ref_id:"..."}},{command:"snapshot",args:{app:"..."}}]), stop_on_error=true, timeout_ms<=60000. ' +
    'Batch commands use CLI names with hyphens, without the desktop_ prefix. Never run dependent desktop actions in parallel. ' +
    'Stop at unknown screens, refresh stale refs, and verify after mutation. Never replay a partially completed batch. Retry only when error disposition.retry is safe. ' +
    'The host controls --headed from the foreground permission and owns recording. These global flags are not per-tool arguments. ' +
    'An upstream timeout or cancellation may follow a completed effect; observe before retrying. Native key-down/up and mouse-down/up can refuse in stateless CLI mode; use press or drag instead.';

export function agentDesktopBatchError(
    args: Record<string, unknown>,
    groups: ComputerUseGroups
): string | undefined {
    let commands: unknown;
    try {
        commands = JSON.parse(String(args.commands_json ?? ''));
    } catch {
        return 'commands_json_must_be_a_JSON_array';
    }
    if (!Array.isArray(commands) || commands.length === 0 || commands.length > 100)
        return 'batch_requires_1_to_100_commands';
    for (const item of commands) {
        if (!isRecord(item) || typeof item.command !== 'string' || !isRecord(item.args))
            return 'invalid_batch_command';
        if (item.command === 'batch') return 'nested_batch_not_supported';
        const group = disabledToolGroup(`desktop_${item.command.replace(/-/g, '_')}`, groups);
        if (group) return `tool_group_disabled:${group}`;
    }
    return undefined;
}
