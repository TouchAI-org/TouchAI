import { skills as nativeSkills } from '@/platform/native/skills';

import type { SkillMetadata } from './contracts';
import { parseSkillMarkdown } from './parser';

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
