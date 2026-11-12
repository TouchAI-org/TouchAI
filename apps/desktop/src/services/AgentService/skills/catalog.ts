import { log } from '@services/ObservabilityService';

import {
    type SkillRootScope,
    skills as nativeSkills,
    type UserSkillMetadataFile,
} from '@/services/NativeService/skills';

import { getBuiltInSkills } from './builtin';
import { parseSkillMarkdown } from './parser';
import type { SkillMetadata } from './types';

export interface DiscoverSkillsOptions {
    includeDisabled?: boolean;
}

function discoverSkillsFromUserSkillFiles(
    files: UserSkillMetadataFile[],
    options: DiscoverSkillsOptions = {}
): SkillMetadata[] {
    const skills: SkillMetadata[] = [];

    for (const file of files) {
        try {
            const parsed = parseSkillMarkdown(file.frontmatter, file.path);
            skills.push({
                name: parsed.name,
                description: parsed.description,
                shortDescription: parsed.shortDescription,
                path: file.path,
                directory: file.directory,
                disabled: file.disabled,
                scope: file.scope,
            });
        } catch {
            log.warn('[Skills] Skipping invalid skill metadata', { path: file.path });
        }
    }

    return skills.filter((skill) => options.includeDisabled || !skill.disabled);
}

export async function getUserSkillsRoot(scope?: SkillRootScope): Promise<string> {
    return nativeSkills.getUserSkillsRoot(scope);
}

export async function discoverSkills(): Promise<SkillMetadata[]> {
    return discoverCatalog();
}

export async function discoverManageableSkills(): Promise<SkillMetadata[]> {
    return discoverCatalog({ includeDisabled: true });
}

async function discoverCatalog(options: DiscoverSkillsOptions = {}): Promise<SkillMetadata[]> {
    const [builtIn, userFiles] = await Promise.all([
        getBuiltInSkills(),
        nativeSkills.discoverUserSkillFiles(),
    ]);
    return [...builtIn, ...discoverSkillsFromUserSkillFiles(userFiles, options)].sort(
        (left, right) => left.name.localeCompare(right.name)
    );
}

export async function readSkillContent(skill: Pick<SkillMetadata, 'path'>): Promise<string> {
    return nativeSkills.readUserSkillFile(skill.path);
}

export async function readEnabledSkillContent(skill: Pick<SkillMetadata, 'path'>): Promise<string> {
    return nativeSkills.readEnabledUserSkillFile(skill.path);
}

export async function setUserSkillDisabled(
    skill: Pick<SkillMetadata, 'path' | 'builtIn'>,
    disabled: boolean
): Promise<void> {
    assertUserSkillLocation(skill);
    await nativeSkills.setUserSkillDisabled(skill.path, disabled);
}

export async function deleteUserSkillDirectory(
    skill: Pick<SkillMetadata, 'directory' | 'builtIn'>
): Promise<void> {
    assertUserSkillLocation(skill);
    await nativeSkills.deleteUserSkillDirectory(skill.directory);
}

export async function openUserSkillsRoot(scope?: SkillRootScope): Promise<void> {
    await nativeSkills.openUserSkillsRoot(scope);
}

export async function openUserSkillDirectory(
    skill: Pick<SkillMetadata, 'directory' | 'builtIn'>
): Promise<void> {
    assertUserSkillLocation(skill);
    await nativeSkills.openUserSkillDirectory(skill.directory);
}

function assertUserSkillLocation(skill: Pick<SkillMetadata, 'builtIn'>): void {
    if (skill.builtIn) throw new Error('Built-in skills are read-only');
}
