import type { SelectedSkill, SkillMetadata } from '@/services/AgentService/skills';
import { normalizeSkillPath } from '@/services/AgentService/skills/path';
import { findOrderedMatchIndices } from '@/utils/searchHighlight';

import type { SearchAction, SearchProvider, SearchResult } from './contracts';

export interface SkillReferenceAction extends SearchAction {
    readonly kind: 'skill.reference';
    readonly skill: SelectedSkill;
}

export interface SkillSearchResult extends SearchResult<SkillReferenceAction> {
    readonly kind: 'skill';
    readonly skill: SkillMetadata;
}

export function filterSkillCandidates(
    skills: SkillMetadata[],
    query: string,
    selected: SelectedSkill[],
    limit = Infinity
): SkillMetadata[] {
    const excluded = new Set(selected.map((skill) => normalizeSkillPath(skill.path)));
    const normalized = query.trim().toLowerCase();
    return skills
        .filter((skill) => !skill.disabled && !excluded.has(normalizeSkillPath(skill.path)))
        .filter(
            (skill) =>
                !normalized ||
                findOrderedMatchIndices(skill.name, normalized) !== null ||
                (skill.shortDescription || skill.description)
                    .trim()
                    .toLowerCase()
                    .includes(normalized)
        )
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, limit);
}

export function createSkillSearchProvider(
    catalog: () => SkillMetadata[] | Promise<SkillMetadata[]>,
    selected: () => SelectedSkill[]
): SearchProvider<SkillSearchResult> {
    return {
        id: 'skills',
        intents: ['skill-reference'],
        async search({ query, cursor, limit, signal }) {
            const offset = Number(cursor ?? 0);
            if (!Number.isSafeInteger(offset) || offset < 0)
                throw new Error('Invalid skill cursor');
            const skills = await catalog();
            if (signal.aborted) return { items: [] };
            const candidates = filterSkillCandidates(skills, query, selected());
            return {
                items: candidates.slice(offset, offset + limit).map((skill): SkillSearchResult => {
                    const action: SkillReferenceAction = {
                        kind: 'skill.reference',
                        skill: { name: skill.name, path: skill.path },
                    };
                    return {
                        id: normalizeSkillPath(skill.path),
                        kind: 'skill',
                        group: 'skill',
                        label: skill.name,
                        description: skill.shortDescription || skill.description,
                        skill,
                        primaryAction: action,
                        completionAction: action,
                    };
                }),
                total: candidates.length,
                nextCursor: offset + limit < candidates.length ? String(offset + limit) : undefined,
            };
        },
    };
}

export function skillSearchItem(result: SearchResult): SkillMetadata | null {
    return result.kind === 'skill' && 'skill' in result
        ? (result as SkillSearchResult).skill
        : null;
}
