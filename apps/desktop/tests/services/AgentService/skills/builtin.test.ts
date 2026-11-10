import { installSkillCommands, skillFile, widgetSkillFile } from '@tests/utils/skills';
import { getTauriInvokeCalls } from '@tests/utils/tauri';
import { beforeEach, describe, expect, it } from 'vitest';

import {
    deleteUserSkillDirectory,
    discoverManageableSkills,
    discoverSkills,
    loadSelectedSkills,
    openUserSkillDirectory,
    readSkillContent,
    setUserSkillDisabled,
} from '@/services/AgentService/skills';
import { activateSkillTool } from '@/services/BuiltInToolService/tools/activateSkill';

const widgetPath = '/app/skills/.system/widget/SKILL.md';
const widget = {
    name: 'widget',
    path: widgetPath,
    directory: '/app/skills/.system/widget',
    builtIn: true,
};

beforeEach(() => installSkillCommands([], [widgetSkillFile()]));

describe('given the app includes a widget skill', () => {
    it('user finds the built-in skill in both selection and settings without a local skill folder', async () => {
        for (const catalog of [await discoverSkills(), await discoverManageableSkills()]) {
            expect(catalog).toContainEqual(expect.objectContaining({ ...widget, builtIn: true }));
        }
        expect(getTauriInvokeCalls('agent_skills_read_user_file')).toEqual([]);
        expect(getTauriInvokeCalls('agent_skills_read_enabled_user_file')).toEqual([]);
    });

    it('user can inspect bundled instructions without receiving an execution credential', async () => {
        const content = await readSkillContent(widget);
        expect(content).toContain('name: widget');
        expect(content).toContain('builtin__show_widget');
        expect(content).toContain('{{WIDGET_SKILL_KEY}}');
        expect(content).not.toContain('i_have_seen_read_me');
        expect(content).not.toContain('visualize_read_me');
    });

    it('user can load the exact built-in path when a local skill has the same name', async () => {
        installSkillCommands([skillFile('widget')], [widgetSkillFile()]);
        const [loaded] = await loadSelectedSkills([widget]);
        expect(loaded?.path).toBe(widgetPath);
        expect(loaded?.content).toContain('builtin__show_widget');
        const result = await activateSkillTool.execute(
            { name: 'widget' },
            {},
            { callId: 'ambiguous', iteration: 0 }
        );
        expect(result.isError).toBe(true);
    });

    it('user cannot delete, disable or open a bundled skill as a local directory', async () => {
        await expect(deleteUserSkillDirectory(widget)).rejects.toThrow(/built-in/i);
        await expect(setUserSkillDisabled(widget, true)).rejects.toThrow(/built-in/i);
        await expect(openUserSkillDirectory(widget)).rejects.toThrow(/built-in/i);
        expect(getTauriInvokeCalls('agent_skills_delete_user_directory')).toEqual([]);
        expect(getTauriInvokeCalls('agent_skills_set_user_skill_disabled')).toEqual([]);
        expect(getTauriInvokeCalls('agent_skills_open_user_directory')).toEqual([]);
    });
});
