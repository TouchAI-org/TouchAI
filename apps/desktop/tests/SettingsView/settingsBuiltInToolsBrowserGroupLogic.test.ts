import { describe, expect, it } from 'vitest';

import {
    getBrowserAutomationTools,
    getBuiltInToolUpdateTargets,
} from '@/views/SettingsView/components/BuiltInTools/browserToolGroup';
import type { BuiltInToolEntity } from '@/views/SettingsView/components/BuiltInTools/types';

function createTool(id: number, toolId: string): BuiltInToolEntity {
    return {
        id,
        tool_id: toolId,
        display_name: toolId,
        description: null,
        enabled: 1,
        risk_level: 'medium',
        config_json: null,
        last_used_at: null,
        created_at: '2026-06-03T00:00:00.000Z',
        updated_at: '2026-06-03T00:00:00.000Z',
    };
}

describe('settings browser built-in tool group logic', () => {
    const tools = [createTool(1, 'browser'), createTool(2, 'bash')];

    it('selects the consolidated browser automation row', () => {
        expect(getBrowserAutomationTools(tools).map((tool) => tool.tool_id)).toEqual(['browser']);
        expect(getBuiltInToolUpdateTargets(tools, tools[0]).map((tool) => tool.id)).toEqual([1]);
    });

    it('selects only the current row for non-browser tools', () => {
        expect(getBuiltInToolUpdateTargets(tools, tools[1]).map((tool) => tool.id)).toEqual([2]);
    });

    it('returns no targets when no tool is selected', () => {
        expect(getBuiltInToolUpdateTargets(tools, null)).toEqual([]);
    });
});
