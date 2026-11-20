import { normalizeSkillPath } from '@/utils/pathIdentity';
import { findOrderedMatchIndices } from '@/utils/searchHighlight';

import type {
    SearchAction,
    SearchProvider,
    SearchResult,
    SkillSearchItem,
    SkillSelection,
} from './contracts';

export interface SkillReferenceAction extends SearchAction {
    readonly kind: 'skill.reference';
    readonly skill: SkillSelection;
}

export interface SkillSearchResult extends SearchResult<SkillReferenceAction> {
    readonly kind: 'skill';
    readonly skill: SkillSearchItem;
}

export function filterSkillCandidates(
    skills: SkillSearchItem[],
    query: string,
    selected: SkillSelection[],
    limit = Infinity
): SkillSearchItem[] {
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
    catalog: () => SkillSearchItem[] | Promise<SkillSearchItem[]>,
    selected: () => SkillSelection[]
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

export function skillSearchItem(result: SearchResult): SkillSearchItem | null {
    return result.kind === 'skill' && 'skill' in result
        ? (result as SkillSearchResult).skill
        : null;
}
