import { invoke } from './invoke';

export interface UserSkillMetadataFile {
    directoryName: string;
    path: string;
    directory: string;
    frontmatter: string;
    disabled: boolean;
    scope: SkillRootScope;
}

export type UserSkillFile = UserSkillMetadataFile;
export type SkillRootScope = 'app' | 'shared';

export const skills = {
    getUserSkillsRoot(scope?: SkillRootScope): Promise<string> {
        return invoke<string>('agent_skills_get_user_root', scope ? { scope } : undefined);
    },

    discoverUserSkillFiles(): Promise<UserSkillMetadataFile[]> {
        return invoke<UserSkillMetadataFile[]>('agent_skills_discover_user_files');
    },

    discoverSystemSkillFiles(): Promise<UserSkillMetadataFile[]> {
        return invoke<UserSkillMetadataFile[]>('agent_skills_discover_system_files');
    },

    readUserSkillFile(path: string): Promise<string> {
        return invoke<string>('agent_skills_read_user_file', { path });
    },

    readEnabledUserSkillFile(path: string): Promise<string> {
        return invoke<string>('agent_skills_read_enabled_user_file', { path });
    },

    deleteUserSkillDirectory(directory: string): Promise<void> {
        return invoke<void>('agent_skills_delete_user_directory', { directory });
    },

    setUserSkillDisabled(path: string, disabled: boolean): Promise<void> {
        return invoke<void>('agent_skills_set_user_skill_disabled', { path, disabled });
    },

    openUserSkillsRoot(scope?: SkillRootScope): Promise<void> {
        return invoke<void>('agent_skills_open_user_root', scope ? { scope } : undefined);
    },

    openUserSkillDirectory(directory: string): Promise<void> {
        return invoke<void>('agent_skills_open_user_directory', { directory });
    },
} as const;
