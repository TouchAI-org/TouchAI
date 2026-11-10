import { describe, expect, it } from 'vitest';

import {
    filterSkillCandidates,
    useSkillAutocomplete,
} from '@/views/SearchView/components/SearchBar/composables/useSkillAutocomplete';

const catalog = [
    {
        name: 'summarize',
        path: '/skills/summarize/SKILL.md',
        directory: '/skills/summarize',
        description: 'Summarize a document',
        shortDescription: null,
    },
    {
        name: 'review',
        path: '/skills/review/SKILL.md',
        directory: '/skills/review',
        description: 'Review a document',
        shortDescription: null,
    },
];

describe.each(['$', '/'])('given the skill picker is opened with %s', (prefix) => {
    it.each(['Enter', 'Tab'])(
        'user given one visible name-prefix match when pressing %s then accepts it while preserving inline completion',
        async (key) => {
            const selections: string[] = [];
            const picker = useSkillAutocomplete({
                discoverSkills: async () => catalog,
                getSelectedSkills: () => [],
                onSelect: (skill) => selections.push(skill.name),
            });
            await picker.refresh(`${prefix}sum`);
            expect(picker.isOpen.value).toBe(true);
            expect(picker.completionText.value).toBe('marize');
            expect(picker.highlightedSkill.value).toBeNull();
            const event = new KeyboardEvent('keydown', { key, cancelable: true });
            expect(picker.handleKeyDown(event)).toBe(true);
            expect(event.defaultPrevented).toBe(true);
            expect(selections).toEqual(['summarize']);
        }
    );

    it('user given a unique name prefix before existing text when browsing then keeps a visible candidate instead of an invisible completion', async () => {
        const picker = useSkillAutocomplete({
            discoverSkills: async () => catalog,
            getSelectedSkills: () => [],
            onSelect: () => undefined,
        });
        await picker.refresh(`${prefix}sum`, { textAfterCursor: ' later' });
        expect(picker.isOpen.value).toBe(true);
        expect(picker.completionText.value).toBe('');
    });

    it('user sees all skills for a bare trigger and matching skills after typing a query', async () => {
        const picker = useSkillAutocomplete({
            discoverSkills: async () => catalog,
            getSelectedSkills: () => [],
            onSelect: () => undefined,
        });
        await picker.refresh(prefix);
        expect(picker.candidates.value.map((skill) => skill.name)).toEqual(['review', 'summarize']);

        await picker.refresh(`${prefix}sum`);
        expect(picker.candidates.value.map((skill) => skill.name)).toEqual(['summarize']);
    });

    it.each(['Enter', 'Tab'])(
        'user presses %s before choosing a suggestion and keeps the draft without submitting or moving focus',
        async (key) => {
            const selections: string[] = [];
            const picker = useSkillAutocomplete({
                discoverSkills: async () => catalog,
                getSelectedSkills: () => [],
                onSelect: (skill) => selections.push(skill.name),
            });
            await picker.refresh(prefix);
            const event = new KeyboardEvent('keydown', { key, cancelable: true });

            expect(picker.handleKeyDown(event)).toBe(true);
            expect(event.defaultPrevented).toBe(true);
            expect(selections).toEqual([]);
            expect(picker.isOpen.value).toBe(true);
            expect(picker.highlightedSkill.value).toBeNull();
        }
    );

    it('user sees an inline suggestion only after choosing a candidate and loses it when editing the query', async () => {
        const picker = useSkillAutocomplete({
            discoverSkills: async () => [catalog[0]!, { ...catalog[1]!, name: 'summary' }],
            getSelectedSkills: () => [],
            onSelect: () => undefined,
        });
        await picker.refresh(`${prefix}sum`);
        expect(picker.completionText.value).toBe('');

        picker.handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
        expect(picker.completionText.value).toBe('marize');

        await picker.refresh(`${prefix}summ`);
        expect(picker.highlightedSkill.value).toBeNull();
        expect(picker.completionText.value).toBe('');
    });

    it('user chooses the first suggestion with ArrowDown and inserts it with Tab without submitting the prompt', async () => {
        const selections: string[] = [];
        const picker = useSkillAutocomplete({
            discoverSkills: async () => catalog,
            getSelectedSkills: () => [],
            onSelect: (skill) => selections.push(skill.name),
        });
        await picker.refresh(prefix);
        picker.handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
        const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
        expect(picker.handleKeyDown(event)).toBe(true);
        expect(selections).toEqual(['review']);
        expect(event.defaultPrevented).toBe(true);
        expect(picker.isOpen.value).toBe(false);
    });

    it('user can finish composing with Enter without inserting a skill', async () => {
        const selections: string[] = [];
        const picker = useSkillAutocomplete({
            discoverSkills: async () => catalog,
            getSelectedSkills: () => [],
            onSelect: (skill) => selections.push(skill.name),
        });
        await picker.refresh(prefix);
        picker.handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
        expect(
            picker.handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }))
        ).toBe(false);
        expect(selections).toEqual([]);
        expect(picker.isOpen.value).toBe(true);
    });

    it.each([
        { gesture: 'Control+Enter', options: { ctrlKey: true } },
        { gesture: 'Command+Enter', options: { metaKey: true } },
        { gesture: 'Alt+Enter', options: { altKey: true } },
        { gesture: 'Shift+Enter', options: { shiftKey: true } },
        { gesture: 'legacy IME Enter', options: { keyCode: 229 } },
    ])('user keeps $gesture available without selecting a skill', async ({ options }) => {
        const selections: string[] = [];
        const picker = useSkillAutocomplete({
            discoverSkills: async () => catalog,
            getSelectedSkills: () => [],
            onSelect: (skill) => selections.push(skill.name),
        });
        await picker.refresh(prefix);
        picker.handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
        const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, ...options });

        expect(picker.handleKeyDown(event)).toBe(false);
        expect(event.defaultPrevented).toBe(false);
        expect(selections).toEqual([]);
        expect(picker.isOpen.value).toBe(true);
    });

    it('user dismisses suggestions with Escape without selecting a skill', async () => {
        const selections: string[] = [];
        const picker = useSkillAutocomplete({
            discoverSkills: async () => catalog,
            getSelectedSkills: () => [],
            onSelect: (skill) => selections.push(skill.name),
        });
        await picker.refresh(prefix);
        const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });

        expect(picker.handleKeyDown(event)).toBe(true);
        expect(event.defaultPrevented).toBe(true);
        expect(selections).toEqual([]);
        expect(picker.isOpen.value).toBe(false);
    });

    it.each(['Enter', 'Tab'])(
        'user presses %s with no matches and retains the empty skill panel until results match again',
        async (key) => {
            const selections: string[] = [];
            const picker = useSkillAutocomplete({
                discoverSkills: async () => catalog,
                getSelectedSkills: () => [],
                onSelect: (skill) => selections.push(skill.name),
            });
            await picker.refresh(`${prefix}missing`);
            expect(picker.candidates.value).toEqual([]);
            expect(picker.isOpen.value).toBe(true);
            expect(picker.activeTrigger.value).toEqual({
                query: 'missing',
                token: `${prefix}missing`,
                suffix: '',
            });
            const event = new KeyboardEvent('keydown', { key, cancelable: true });

            expect(picker.handleKeyDown(event)).toBe(true);
            expect(event.defaultPrevented).toBe(true);
            expect(picker.isOpen.value).toBe(true);
            expect(picker.query.value).toBe('missing');
            expect(picker.activeTrigger.value?.token).toBe(`${prefix}missing`);
            expect(selections).toEqual([]);

            await picker.refresh(`${prefix}sum`);
            expect(picker.isOpen.value).toBe(true);
            expect(picker.candidates.value.map((skill) => skill.name)).toEqual(['summarize']);
            expect(picker.highlightedSkill.value).toBeNull();
            expect(picker.completionText.value).toBe('marize');
        }
    );

    it('user can search using a translated description', async () => {
        const picker = useSkillAutocomplete({
            discoverSkills: async () => [{ ...catalog[0]!, description: '总结文档' }],
            getSelectedSkills: () => [],
            onSelect: () => undefined,
        });
        await picker.refresh(`${prefix}总结`);
        expect(picker.candidates.value.map((skill) => skill.name)).toEqual(['summarize']);
    });
});

describe('given the skill catalog contains unavailable choices', () => {
    it('user cannot accept a retained skill while refresh is pending or after it is removed', async () => {
        let resolveRefresh!: (value: typeof catalog) => void;
        let refresh = false;
        const selected: string[] = [];
        const picker = useSkillAutocomplete({
            discoverSkills: () =>
                refresh
                    ? new Promise((resolve) => (resolveRefresh = resolve))
                    : Promise.resolve(catalog),
            getSelectedSkills: () => [],
            onSelect: (skill) => selected.push(skill.name),
        });
        await picker.refresh('/');
        picker.handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
        picker.handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
        expect(picker.completionText.value).toBe('summarize');
        refresh = true;
        const pending = picker.refresh('/', { resume: true });
        expect(picker.completionText.value).toBe('summarize');
        for (const key of ['Enter', 'Tab']) {
            const event = new KeyboardEvent('keydown', { key, cancelable: true });
            expect(picker.handleKeyDown(event)).toBe(true);
            expect(event.defaultPrevented).toBe(true);
        }
        picker.selectSkill(catalog[0]!);
        expect(selected).toEqual([]);
        expect(picker.isOpen.value).toBe(true);

        resolveRefresh([catalog[1]!]);
        await pending;
        expect(picker.highlightedSkill.value).toBeNull();
        expect(picker.completionText.value).toBe('');
        picker.selectHighlighted();
        expect(selected).toEqual([]);
        picker.selectSkill(catalog[0]!);
        expect(selected).toEqual([]);
        picker.selectSkill(catalog[1]!);
        expect(selected).toEqual(['review']);
    });

    it('user never sees disabled skills even when the catalog contains them', () => {
        expect(filterSkillCandidates([{ ...catalog[0]!, disabled: true }], '', [])).toEqual([]);
    });

    it('user can select a distinct case-sensitive path on Linux', () => {
        expect(
            filterSkillCandidates(catalog, '', [
                { name: 'other', path: '/skills/Summarize/SKILL.md' },
            ])
        ).toHaveLength(2);
    });
});
