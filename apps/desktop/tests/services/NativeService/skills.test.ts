import { getLastTauriInvokeCall, mockTauriCommand } from '@tests/utils/tauri';
import { describe, expect, it } from 'vitest';

import { skills } from '@/services/NativeService/skills';

describe('NativeService skills', () => {
    it('user given application skills when opening their folder then uses the application scope', async () => {
        mockTauriCommand('agent_skills_open_user_root', undefined);
        await skills.openUserSkillsRoot('app');
        expect(getLastTauriInvokeCall('agent_skills_open_user_root')?.payload).toEqual({
            scope: 'app',
        });
    });
    it('user gets the user skills root through the controlled native command', async () => {
        mockTauriCommand('agent_skills_get_user_root', 'C:/Users/demo/.agents/skills');

        await expect(skills.getUserSkillsRoot()).resolves.toBe('C:/Users/demo/.agents/skills');

        expect(getLastTauriInvokeCall('agent_skills_get_user_root')).toEqual({
            cmd: 'agent_skills_get_user_root',
            payload: undefined,
        });
    });

    it('user discovers user skill files through the controlled native command', async () => {
        const skillFiles = [
            {
                directoryName: 'demo',
                path: 'C:/Users/demo/.agents/skills/demo/SKILL.md',
                directory: 'C:/Users/demo/.agents/skills/demo',
                scope: 'shared',
                frontmatter: '---\nname: demo\ndescription: Demo skill.\n---\n',
                disabled: false,
            },
        ];
        mockTauriCommand('agent_skills_discover_user_files', skillFiles);

        await expect(skills.discoverUserSkillFiles()).resolves.toEqual(skillFiles);

        expect(getLastTauriInvokeCall('agent_skills_discover_user_files')).toEqual({
            cmd: 'agent_skills_discover_user_files',
            payload: undefined,
        });
    });

    it('user receives bundled skill metadata when discovering system skills', async () => {
        const skillFiles = [
            {
                directoryName: 'widget',
                path: 'D:/TouchAI/skills/.system/widget/SKILL.md',
                directory: 'D:/TouchAI/skills/.system/widget',
                scope: 'app',
                frontmatter: '---\nname: widget\ndescription: Create interactive widgets.\n---\n',
                disabled: false,
            },
        ];
        mockTauriCommand('agent_skills_discover_system_files', skillFiles);

        await expect(skills.discoverSystemSkillFiles()).resolves.toEqual(skillFiles);

        expect(getLastTauriInvokeCall('agent_skills_discover_system_files')).toEqual({
            cmd: 'agent_skills_discover_system_files',
            payload: undefined,
        });
    });

    it('user reads a selected user skill file through the controlled native command', async () => {
        mockTauriCommand('agent_skills_read_user_file', '# Demo skill');

        await expect(
            skills.readUserSkillFile('C:/Users/demo/.agents/skills/demo/SKILL.md')
        ).resolves.toBe('# Demo skill');

        expect(getLastTauriInvokeCall('agent_skills_read_user_file')).toEqual({
            cmd: 'agent_skills_read_user_file',
            payload: { path: 'C:/Users/demo/.agents/skills/demo/SKILL.md' },
        });
    });

    it('user reads an enabled user skill file through the main-session native command', async () => {
        mockTauriCommand('agent_skills_read_enabled_user_file', '# Demo skill');

        await expect(
            skills.readEnabledUserSkillFile('C:/Users/demo/.agents/skills/demo/SKILL.md')
        ).resolves.toBe('# Demo skill');

        expect(getLastTauriInvokeCall('agent_skills_read_enabled_user_file')).toEqual({
            cmd: 'agent_skills_read_enabled_user_file',
            payload: { path: 'C:/Users/demo/.agents/skills/demo/SKILL.md' },
        });
    });

    it('user deletes a selected user skill directory through the controlled native command', async () => {
        mockTauriCommand('agent_skills_delete_user_directory', undefined);

        await expect(
            skills.deleteUserSkillDirectory('C:/Users/demo/.agents/skills/demo')
        ).resolves.toBeUndefined();

        expect(getLastTauriInvokeCall('agent_skills_delete_user_directory')).toEqual({
            cmd: 'agent_skills_delete_user_directory',
            payload: { directory: 'C:/Users/demo/.agents/skills/demo' },
        });
    });

    it('user persists selected user skill disabled state through the controlled native command', async () => {
        mockTauriCommand('agent_skills_set_user_skill_disabled', undefined);

        await expect(
            skills.setUserSkillDisabled('C:/Users/demo/.agents/skills/demo/SKILL.md', true)
        ).resolves.toBeUndefined();

        expect(getLastTauriInvokeCall('agent_skills_set_user_skill_disabled')).toEqual({
            cmd: 'agent_skills_set_user_skill_disabled',
            payload: {
                path: 'C:/Users/demo/.agents/skills/demo/SKILL.md',
                disabled: true,
            },
        });
    });

    it('user opens the user skills root through the controlled native command', async () => {
        mockTauriCommand('agent_skills_open_user_root', undefined);

        await expect(skills.openUserSkillsRoot()).resolves.toBeUndefined();

        expect(getLastTauriInvokeCall('agent_skills_open_user_root')).toEqual({
            cmd: 'agent_skills_open_user_root',
            payload: undefined,
        });
    });

    it('user opens a selected user skill directory through the controlled native command', async () => {
        mockTauriCommand('agent_skills_open_user_directory', undefined);

        await expect(
            skills.openUserSkillDirectory('C:/Users/demo/.agents/skills/demo')
        ).resolves.toBeUndefined();

        expect(getLastTauriInvokeCall('agent_skills_open_user_directory')).toEqual({
            cmd: 'agent_skills_open_user_directory',
            payload: { directory: 'C:/Users/demo/.agents/skills/demo' },
        });
    });
});
