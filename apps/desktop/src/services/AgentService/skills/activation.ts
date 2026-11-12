import { discoverSkills, readEnabledSkillContent } from './catalog';
import { parseSkillMarkdown } from './parser';
import { normalizeSkillPath } from './path';
import type {
    LoadedSkillContext,
    PromptSnapshotSkill,
    SelectedSkill,
    SkillActivationSource,
    SkillMetadata,
} from './types';

type SkillReader = (path: string) => Promise<string>;

export const MAX_SKILL_CONTENT_CHARS = 200_000;
export const MAX_SELECTED_SKILLS = 16;
export const MAX_SELECTED_SKILL_CONTENT_CHARS = 1_000_000;

function bytesToHex(bytes: ArrayBuffer): string {
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(text: string): Promise<string> {
    const encoded = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', encoded);
    return bytesToHex(digest);
}

export function buildSkillContextText(skill: {
    name: string;
    path: string;
    content: string;
}): string {
    const escapeSkillContextBoundary = (value: string) =>
        value.replace(/<\/skill>/gi, '<\\/skill>');

    return [
        '<skill>',
        `<name>${escapeSkillContextBoundary(skill.name)}</name>`,
        `<path>${escapeSkillContextBoundary(skill.path)}</path>`,
        escapeSkillContextBoundary(skill.content),
        '</skill>',
    ].join('\n');
}

function assertSkillContentWithinLimit(path: string, content: string) {
    if (content.length <= MAX_SKILL_CONTENT_CHARS) {
        return;
    }

    throw new Error(
        `Skill content is too large to load: ${path} (${content.length}/${MAX_SKILL_CONTENT_CHARS} characters)`
    );
}

export async function loadSelectedSkillsWithReader(
    selectedSkills: SelectedSkill[],
    readSkillFile: SkillReader,
    activatedBy: SkillActivationSource
): Promise<LoadedSkillContext[]> {
    const loaded: LoadedSkillContext[] = [];
    const seenPaths = new Set<string>();
    let totalContentChars = 0;

    for (const selectedSkill of selectedSkills) {
        if (seenPaths.has(normalizeSkillPath(selectedSkill.path))) {
            continue;
        }
        seenPaths.add(normalizeSkillPath(selectedSkill.path));
        if (seenPaths.size > MAX_SELECTED_SKILLS) {
            throw new Error(`At most ${MAX_SELECTED_SKILLS} skills can be loaded per turn`);
        }

        const content = await readSkillFile(selectedSkill.path);
        assertSkillContentWithinLimit(selectedSkill.path, content);
        totalContentChars += content.length;
        if (totalContentChars > MAX_SELECTED_SKILL_CONTENT_CHARS) {
            throw new Error(
                `Selected skill content exceeds ${MAX_SELECTED_SKILL_CONTENT_CHARS} characters`
            );
        }
        const parsed = parseSkillMarkdown(content, selectedSkill.path);
        const name = selectedSkill.name || parsed.name;
        const contextText = buildSkillContextText({
            name,
            path: selectedSkill.path,
            content,
        });
        loaded.push({
            name,
            description: parsed.description,
            shortDescription: parsed.shortDescription,
            path: selectedSkill.path,
            directory: parsed.directory,
            hash: await sha256(content),
            activatedBy,
            content,
            contextText,
        });
    }

    return loaded;
}

export async function loadSelectedSkillsFromCatalogWithReader(
    selectedSkills: SelectedSkill[],
    catalog: SkillMetadata[],
    readSkillFile: SkillReader,
    activatedBy: SkillActivationSource
): Promise<LoadedSkillContext[]> {
    const catalogByPath = new Map(
        catalog
            .filter((skill) => !skill.disabled)
            .map((skill) => [normalizeSkillPath(skill.path), skill] as const)
    );
    const catalogSelectedSkills = selectedSkills.map((selectedSkill) => {
        const catalogSkill = catalogByPath.get(normalizeSkillPath(selectedSkill.path));
        if (!catalogSkill) {
            throw new Error(
                `Selected skill is not in the available skill catalog: ${selectedSkill.path}`
            );
        }

        return {
            name: catalogSkill.name,
            path: catalogSkill.path,
        };
    });

    return loadSelectedSkillsWithReader(catalogSelectedSkills, readSkillFile, activatedBy);
}

export async function loadSelectedSkills(
    selectedSkills: SelectedSkill[],
    activatedBy: SkillActivationSource = 'user_tag'
): Promise<LoadedSkillContext[]> {
    if (selectedSkills.length === 0) return [];
    const catalog = await discoverSkills();
    return loadSelectedSkillsFromCatalogWithReader(
        selectedSkills,
        catalog,
        (path) => readEnabledSkillContent({ path }),
        activatedBy
    );
}

export function summarizeLoadedSkills(skills: LoadedSkillContext[]): PromptSnapshotSkill[] {
    return skills.map((skill) => ({
        name: skill.name,
        path: skill.path,
        hash: skill.hash,
        activatedBy: skill.activatedBy,
    }));
}
