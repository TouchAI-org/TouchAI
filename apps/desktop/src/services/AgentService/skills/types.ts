import type { SkillRootScope } from '@/services/NativeService/skills';

export interface SkillMetadata {
    name: string;
    description: string;
    shortDescription: string | null;
    path: string;
    directory: string;
    disabled?: boolean;
    builtIn?: boolean;
    scope?: SkillRootScope;
}

export interface ParsedSkill extends SkillMetadata {
    body: string;
}

export interface SelectedSkill {
    name: string;
    path: string;
}

export type SkillActivationSource = 'user_tag' | 'model_tool';

export interface LoadedSkillContext extends SkillMetadata {
    hash: string;
    activatedBy: SkillActivationSource;
    content: string;
    contextText: string;
}

export interface PromptSnapshotSkill {
    name: string;
    path: string;
    hash: string;
    activatedBy: SkillActivationSource;
}
