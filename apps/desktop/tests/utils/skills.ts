import type { InvokeArgs } from '@tauri-apps/api/core';

import { mockTauriCommand } from './tauri';

export function skillFile(name = 'summary', disabled = false, scope: 'app' | 'shared' = 'shared') {
    const directory = `${scope === 'app' ? '/app/skills' : '/home/user/.agents/skills'}/${name}`;
    return {
        directoryName: name,
        name,
        path: `${directory}/SKILL.md`,
        directory,
        disabled,
        scope,
        frontmatter: `---\nname: ${name}\ndescription: Summarize ${name} documents\n---\n`,
        content: `---\nname: ${name}\ndescription: Summarize ${name} documents\n---\n# Private ${name} instructions`,
    };
}

export function widgetSkillFile() {
    const directory = '/app/skills/.system/widget';
    const frontmatter = '---\nname: widget\ndescription: Create interactive widgets\n---\n';
    return {
        directoryName: 'widget',
        name: 'widget',
        path: `${directory}/SKILL.md`,
        directory,
        disabled: false,
        scope: 'app' as const,
        frontmatter,
        content: `${frontmatter}Use builtin__show_widget with skill_key: {{WIDGET_SKILL_KEY}}`,
    };
}

export function installSkillCommands(
    initial = [skillFile()],
    system = [] as ReturnType<typeof skillFile>[]
) {
    const files = [...initial];
    mockTauriCommand('agent_skills_get_user_root', '/home/user/.agents/skills');
    mockTauriCommand('agent_skills_discover_user_files', () =>
        files.map(({ directoryName, name, path, directory, disabled, frontmatter, scope }) => ({
            directoryName,
            name,
            path,
            directory,
            disabled,
            scope,
            frontmatter,
        }))
    );
    mockTauriCommand('agent_skills_discover_system_files', () =>
        system.map(({ directoryName, path, directory, disabled, frontmatter, scope }) => ({
            directoryName,
            path,
            directory,
            disabled,
            scope,
            frontmatter,
        }))
    );
    for (const command of ['agent_skills_read_user_file', 'agent_skills_read_enabled_user_file']) {
        mockTauriCommand(command, (args?: InvokeArgs) => {
            const file = [...system, ...files].find(
                (file) => file.path === (args as { path: string }).path
            );
            if (!file || (command === 'agent_skills_read_enabled_user_file' && file.disabled))
                throw new Error('Skill unavailable');
            return file.content;
        });
    }
    mockTauriCommand('agent_skills_set_user_skill_disabled', (args?: InvokeArgs) => {
        const { path, disabled } = args as { path: string; disabled: boolean };
        const file = files.find((file) => file.path === path);
        if (!file) throw new Error('Skill unavailable');
        file.disabled = disabled;
    });
    mockTauriCommand('agent_skills_delete_user_directory', (args?: InvokeArgs) => {
        const index = files.findIndex(
            (file) => file.directory === (args as { directory: string }).directory
        );
        if (index < 0) throw new Error('Skill unavailable');
        files.splice(index, 1);
    });
    return files;
}
