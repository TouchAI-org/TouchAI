import { skills as nativeSkills } from '@/services/NativeService/skills';

import { parseSkillMarkdown } from './parser';
import type { SkillMetadata } from './types';

export async function getBuiltInSkills(): Promise<SkillMetadata[]> {
    const files = await nativeSkills.discoverSystemSkillFiles();
    return files.map((file) => {
        const parsed = parseSkillMarkdown(file.frontmatter, file.path);
        return {
            name: parsed.name,
            description: parsed.description,
            shortDescription: parsed.shortDescription,
            path: file.path,
            directory: file.directory,
            builtIn: true,
            scope: file.scope,
        };
    });
}
