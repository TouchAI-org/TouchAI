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
    const tools = [
        createTool(1, 'browser_session'),
        createTool(2, 'browser_observe'),
        createTool(3, 'browser_act'),
        createTool(4, 'bash'),
    ];

    it('selects all browser automation rows from any browser row', () => {
        expect(getBrowserAutomationTools(tools).map((tool) => tool.tool_id)).toEqual([
            'browser_session',
            'browser_observe',
            'browser_act',
        ]);
        expect(getBuiltInToolUpdateTargets(tools, tools[1]).map((tool) => tool.id)).toEqual([
            1, 2, 3,
        ]);
    });

    it('selects only the current row for non-browser tools', () => {
        expect(getBuiltInToolUpdateTargets(tools, tools[3]).map((tool) => tool.id)).toEqual([4]);
    });

    it('returns no targets when no tool is selected', () => {
        expect(getBuiltInToolUpdateTargets(tools, null)).toEqual([]);
    });
});
