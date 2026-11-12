import { describe, expect, it } from 'vitest';

import { SearchProviderRegistry } from '@/services/SearchService';
import { createSkillSearchProvider, skillSearchItem } from '@/services/SearchService/skills';

describe('given the skills catalog contributes metadata to search', () => {
    it('user finds fuzzy skill names and receives only a metadata reference action', async () => {
        const skill = {
            name: 'skill-creator',
            path: '/skills/creator/SKILL.md',
            directory: '/skills/creator',
            description: 'Create a skill',
            shortDescription: null,
        };
        const provider = createSkillSearchProvider(
            () => [skill],
            () => []
        );
        const registry = new SearchProviderRegistry();
        const session = registry.createSession([provider]);
        await session.search({ query: 'skillc', intent: 'skill-reference' });
        expect(session.snapshot.items).toHaveLength(1);
        const result = session.snapshot.items[0]!.result;
        expect(skillSearchItem(result)).toEqual(skill);
        expect(result.primaryAction).toEqual({
            kind: 'skill.reference',
            skill: { name: skill.name, path: skill.path },
        });
        expect(result.completionAction).toEqual(result.primaryAction);
    });

    it('user gets no skill results from the ordinary launcher or for selected skills', async () => {
        const skill = {
            name: 'summary',
            path: '/summary/SKILL.md',
            directory: '/summary',
            description: 'Summarize',
            shortDescription: null,
        };
        const registry = new SearchProviderRegistry();
        const session = registry.createSession([
            createSkillSearchProvider(
                () => [skill],
                () => [skill]
            ),
        ]);
        await session.search({ query: '', intent: 'skill-reference' });
        expect(session.snapshot.items).toEqual([]);
        await session.search({ query: 'summary', intent: 'launcher' });
        expect(session.snapshot.providers).toEqual([]);
    });
});
