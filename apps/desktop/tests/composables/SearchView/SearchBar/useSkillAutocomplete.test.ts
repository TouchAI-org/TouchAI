import { mountComposable } from '@tests/utils/composables';
import { describe, expect, it, vi } from 'vitest';

import type { SelectedSkill, SkillMetadata } from '@/services/AgentService/skills';
import {
    containsSkillQuery,
    filterSkillCandidates,
    resolveSkillTrigger,
    useSkillAutocomplete,
} from '@/views/SearchView/components/SearchBar/composables/useSkillAutocomplete';

const skills: SkillMetadata[] = [
    {
        name: 'code-quality-review',
        description: 'Review code quality and design risks.',
        shortDescription: 'Quality review',
        path: 'C:/Users/demo/.agents/skills/code-quality-review/SKILL.md',
        directory: 'C:/Users/demo/.agents/skills/code-quality-review',
    },
    {
        name: 'ui-ux-pro-max',
        description: 'Review interaction design and visual polish.',
        shortDescription: 'UI review',
        path: 'C:/Users/demo/.agents/skills/ui-ux-pro-max/SKILL.md',
        directory: 'C:/Users/demo/.agents/skills/ui-ux-pro-max',
    },
];

async function flushAsyncWork() {
    await Promise.resolve();
    await Promise.resolve();
}

function keyboardEvent(key: string, options: KeyboardEventInit = {}) {
    const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        ...options,
    });
    return {
        event,
        preventDefault: vi.spyOn(event, 'preventDefault'),
        stopPropagation: vi.spyOn(event, 'stopPropagation'),
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

describe('given a draft may contain a skill query', () => {
    it('user detects dollar skill triggers only at token boundaries', () => {
        expect(resolveSkillTrigger('$code')).toEqual({
            query: 'code',
            token: '$code',
            suffix: '',
        });
        expect(resolveSkillTrigger('please use $ui-ux')).toEqual({
            query: 'ui-ux',
            token: '$ui-ux',
            suffix: '',
        });
        expect(resolveSkillTrigger('please use $code.quality:review_1')).toEqual({
            query: 'code.quality:review_1',
            token: '$code.quality:review_1',
            suffix: '',
        });
        expect(resolveSkillTrigger('email@example.com')).toBeNull();
        expect(resolveSkillTrigger('price$code')).toBeNull();
        expect(resolveSkillTrigger('please use $skill!')).toBeNull();
        expect(resolveSkillTrigger('plain text')).toBeNull();
    });

    it.each(['', 'please use ', '\t', '\n', '\ufffc', 'notes\ufffc'])(
        'user gets the same slash and dollar queries after the boundary %j',
        (boundary) => {
            for (const query of ['', 'sum', '总结', 'code.quality:review_1']) {
                expect(resolveSkillTrigger(`${boundary}/${query}`)).toEqual({
                    query,
                    token: `/${query}`,
                    suffix: '',
                });
                expect(resolveSkillTrigger(`${boundary}$${query}`)).toEqual({
                    query,
                    token: `$${query}`,
                    suffix: '',
                });
            }
        }
    );

    it.each([
        'https://example.com',
        'C:/Users',
        'foo/bar',
        '/usr/local',
        '/usr/',
        '/usr\\local',
        '//server',
        './summary',
        '../summary',
        '~/summary',
    ])('user keeps %s available for ordinary search without opening skills', (text) => {
        expect(resolveSkillTrigger(text)).toBeNull();
        expect(containsSkillQuery(text)).toBe(false);
        expect(containsSkillQuery(`Find ${text} today`)).toBe(false);
    });

    it.each(['$', '/'])(
        'user retains skill intent when a %s query precedes other draft text',
        (prefix) => {
            expect(containsSkillQuery(`${prefix}sum then review the notes`)).toBe(true);
            expect(containsSkillQuery(`notes\ufffc${prefix}sum then review`)).toBe(true);
            expect(containsSkillQuery(`/usr/local ${prefix}sum today`)).toBe(true);
            expect(containsSkillQuery(`notes${prefix}sum`)).toBe(false);
        }
    );

    it.each(['/', '\\'])(
        'user regains ordinary search when a slash query becomes a path using %s',
        (separator) => {
            expect(containsSkillQuery('/usr')).toBe(true);
            expect(containsSkillQuery(`/usr${separator}`)).toBe(false);
            expect(containsSkillQuery(`/usr${separator}local`)).toBe(false);
            expect(containsSkillQuery(`/usr${separator}local notes`)).toBe(false);
        }
    );
});

describe('given the catalog includes a selected skill', () => {
    it.each(['skillc', 'skcr', 'SKILLC', 's-c'])(
        'user given separated skill names when searching %j then finds ordered name matches without unrelated descriptions',
        (query) => {
            const catalog = ['skill-creator', 'skill creator', 'review'].map((name) => ({
                ...skills[0]!,
                name,
                path: `/skills/${name}/SKILL.md`,
                description: 'Some knowledge is listed lazily. Create resources.',
                shortDescription: null,
            }));
            const expected =
                query === 's-c' ? ['skill-creator'] : ['skill creator', 'skill-creator'];
            expect(filterSkillCandidates(catalog, query, []).map((skill) => skill.name)).toEqual(
                expected.sort((left, right) => left.localeCompare(right))
            );
        }
    );

    it('user given a fuzzy skill name when its letters are out of order or unavailable then sees no candidate', () => {
        const creator = { ...skills[0]!, name: 'skill-creator' };
        expect(filterSkillCandidates([creator], 'crskill', [])).toEqual([]);
        expect(filterSkillCandidates([{ ...creator, disabled: true }], 'skillc', [])).toEqual([]);
        expect(filterSkillCandidates([creator], 'skillc', [creator])).toEqual([]);
    });

    it.each(['', 'review'])(
        'user given skills in discovery order when searching %j then sees matches alphabetically by name',
        (query) => {
            const catalog = ['zebra', 'review-helper', 'alpha'].map((name) => ({
                ...skills[0]!,
                name,
                path: `/skills/${name}/SKILL.md`,
                description: 'A review helper',
                shortDescription: null,
            }));
            expect(filterSkillCandidates(catalog, query, []).map((skill) => skill.name)).toEqual([
                'alpha',
                'review-helper',
                'zebra',
            ]);
        }
    );

    it('user given a keyword found only in hidden metadata when searching then sees only matches in the name or displayed description', () => {
        expect(filterSkillCandidates(skills, 'interaction', [])).toEqual([]);
        expect(filterSkillCandidates(skills, 'quality', []).map((skill) => skill.name)).toEqual([
            'code-quality-review',
        ]);
        expect(
            filterSkillCandidates([{ ...skills[1]!, shortDescription: null }], 'interaction', [])
        ).toHaveLength(1);
    });

    it('user given more than eight enabled skills when opening slash completion then can navigate and select the last catalog entry', async () => {
        const catalog = Array.from({ length: 31 }, (_, index) => ({
            ...skills[0]!,
            name: `skill-${index.toString().padStart(2, '0')}`,
            path: `/skills/skill-${index}/SKILL.md`,
        }));
        const onSelect = vi.fn();
        const picker = useSkillAutocomplete({
            discoverSkills: async () => catalog,
            getSelectedSkills: () => [],
            onSelect,
        });
        await picker.refresh('/');
        expect(picker.candidates.value).toHaveLength(catalog.length);
        for (let index = 0; index < catalog.length; index++) {
            picker.handleKeyDown(keyboardEvent('ArrowDown').event);
        }
        expect(picker.highlightedSkill.value?.name).toBe('skill-30');
        picker.handleKeyDown(keyboardEvent('Tab').event);
        expect(onSelect).toHaveBeenCalledWith(
            { name: 'skill-30', path: '/skills/skill-30/SKILL.md' },
            { query: '', token: '/', suffix: '' }
        );
    });

    it('user matches name and description while excluding already selected skills', () => {
        const selected: SelectedSkill[] = [
            {
                name: 'code-quality-review',
                path: 'C:/Users/demo/.agents/skills/code-quality-review/SKILL.md',
            },
        ];

        expect(
            filterSkillCandidates(skills, 'review', selected).map((skill) => skill.name)
        ).toEqual(['ui-ux-pro-max']);
        expect(filterSkillCandidates(skills, '', [], 1).map((skill) => skill.name)).toEqual([
            'code-quality-review',
        ]);
    });
});

describe('given the user is entering a skill query', () => {
    it('user given the first or last skill when navigating beyond it then follows the same bounded selection as files', async () => {
        const picker = useSkillAutocomplete({
            discoverSkills: async () => skills,
            getSelectedSkills: () => [],
            onSelect: () => undefined,
        });
        await picker.refresh('/');
        picker.handleKeyDown(keyboardEvent('ArrowUp').event);
        expect(picker.highlightedIndex.value).toBe(-1);
        for (let index = 0; index < skills.length + 3; index++) {
            picker.handleKeyDown(keyboardEvent('ArrowDown').event);
        }
        expect(picker.highlightedIndex.value).toBe(skills.length - 1);
        for (let index = 0; index < skills.length + 3; index++) {
            picker.handleKeyDown(keyboardEvent('ArrowUp').event);
        }
        expect(picker.highlightedIndex.value).toBe(-1);
    });

    it.each(['$', '/'])(
        'user given visible %s suggestions when editing the keyword then keeps the picker open until filtering completes',
        async (prefix) => {
            const onSelect = vi.fn();
            const picker = useSkillAutocomplete({
                discoverSkills: async () => skills,
                getSelectedSkills: () => [],
                onSelect,
            });
            await picker.refresh(prefix);
            picker.moveHighlight(1);

            const filtering = picker.refresh(`${prefix}quality`);

            expect(picker.isOpen.value).toBe(true);
            expect(picker.candidates.value.map((skill) => skill.name)).toEqual([
                'code-quality-review',
            ]);
            expect(picker.highlightedSkill.value).toBeNull();
            picker.selectSkill(skills[0]!);
            picker.handleKeyDown(keyboardEvent('Tab').event);
            expect(onSelect).not.toHaveBeenCalled();
            await filtering;
            expect(picker.candidates.value.map((skill) => skill.name)).toEqual([
                'code-quality-review',
            ]);
            expect(picker.isOpen.value).toBe(true);

            await picker.refresh(`${prefix}no-such-skill`);
            expect(picker.isOpen.value).toBe(true);
            expect(picker.candidates.value).toEqual([]);
        }
    );

    it.each(['$', '/'])(
        'user requests insertion for %s without choosing a candidate and keeps the picker open',
        async (prefix) => {
            const selections: SelectedSkill[] = [];
            const picker = useSkillAutocomplete({
                discoverSkills: async () => skills,
                getSelectedSkills: () => [],
                onSelect: (skill) => selections.push(skill),
            });
            await picker.refresh(prefix);
            expect(picker.highlightedSkill.value).toBeNull();

            picker.selectHighlighted();

            expect(selections).toEqual([]);
            expect(picker.isOpen.value).toBe(true);
        }
    );

    it.each(['$', '/'])(
        'user filters candidates with %s and inserts a match with Enter',
        async (prefix) => {
            const onSelect = vi.fn();
            const { event, preventDefault, stopPropagation } = keyboardEvent('Enter');

            const mounted = await mountComposable(() =>
                useSkillAutocomplete({
                    discoverSkills: async () => skills,
                    getSelectedSkills: () => [],
                    onSelect,
                })
            );

            await mounted.result.refresh(`please use ${prefix}ui-ux`);
            await flushAsyncWork();

            expect(mounted.result.isOpen.value).toBe(true);
            expect(mounted.result.completionText.value).toBe('-pro-max');
            expect(mounted.result.isLoading.value).toBe(false);
            expect(mounted.result.candidates.value.map((skill) => skill.name)).toEqual([
                'ui-ux-pro-max',
            ]);

            mounted.result.handleKeyDown(keyboardEvent('ArrowDown').event);
            expect(mounted.result.handleKeyDown(event)).toBe(true);
            expect(preventDefault).toHaveBeenCalled();
            expect(stopPropagation).toHaveBeenCalled();
            expect(onSelect).toHaveBeenCalledWith(
                {
                    name: 'ui-ux-pro-max',
                    path: 'C:/Users/demo/.agents/skills/ui-ux-pro-max/SKILL.md',
                },
                {
                    query: 'ui-ux',
                    token: `${prefix}ui-ux`,
                    suffix: '',
                }
            );
            expect(mounted.result.isOpen.value).toBe(false);

            mounted.unmount();
        }
    );

    it('user keeps a completed path after a pending slash query finishes loading', async () => {
        const catalog = deferred<SkillMetadata[]>();
        const selections: SelectedSkill[] = [];
        const picker = useSkillAutocomplete({
            discoverSkills: async () => catalog.promise,
            getSelectedSkills: () => [],
            onSelect: (skill) => selections.push(skill),
        });

        const loading = picker.refresh('/usr');
        expect(picker.isOpen.value).toBe(false);
        expect(picker.isLoading.value).toBe(true);
        expect(picker.activeTrigger.value).toEqual({ query: 'usr', token: '/usr', suffix: '' });

        await picker.refresh('/usr/local');
        catalog.resolve(skills);
        await loading;

        expect(picker.isOpen.value).toBe(false);
        expect(picker.candidates.value).toEqual([]);
        const enter = keyboardEvent('Enter').event;
        expect(picker.handleKeyDown(enter)).toBe(false);
        expect(enter.defaultPrevented).toBe(false);
        expect(selections).toEqual([]);
    });

    it('user refreshes the skill catalog each time autocomplete opens', async () => {
        const discoverSkills = vi
            .fn()
            .mockResolvedValueOnce([skills[0]])
            .mockResolvedValueOnce([skills[1]]);
        const mounted = await mountComposable(() =>
            useSkillAutocomplete({
                discoverSkills,
                getSelectedSkills: () => [],
                onSelect: vi.fn(),
            })
        );

        await mounted.result.refresh('please use $');
        await flushAsyncWork();
        expect(mounted.result.candidates.value.map((skill) => skill.name)).toEqual([
            'code-quality-review',
        ]);

        mounted.result.close();
        await mounted.result.refresh('please use $');
        await flushAsyncWork();

        expect(discoverSkills).toHaveBeenCalledTimes(2);
        expect(mounted.result.candidates.value.map((skill) => skill.name)).toEqual([
            'ui-ux-pro-max',
        ]);

        mounted.unmount();
    });

    it('user closes when the trigger disappears and ignores the stale catalog response', async () => {
        const catalog = deferred<SkillMetadata[]>();
        const mounted = await mountComposable(() =>
            useSkillAutocomplete({
                discoverSkills: async () => catalog.promise,
                getSelectedSkills: () => [],
                onSelect: vi.fn(),
            })
        );

        const firstRefresh = mounted.result.refresh('please use $');
        expect(mounted.result.isOpen.value).toBe(false);
        expect(mounted.result.isLoading.value).toBe(true);
        expect(mounted.result.activeTrigger.value).toEqual({ query: '', token: '$', suffix: '' });

        await mounted.result.refresh('please use ');
        expect(mounted.result.isOpen.value).toBe(false);
        expect(mounted.result.candidates.value).toEqual([]);

        catalog.resolve(skills);
        await firstRefresh;
        await flushAsyncWork();

        expect(mounted.result.isOpen.value).toBe(false);
        expect(mounted.result.activeTrigger.value).toBeNull();
        expect(mounted.result.candidates.value).toEqual([]);

        mounted.unmount();
    });

    it('user retains a failed skill query for retry while suggestions stay hidden', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const mounted = await mountComposable(() =>
            useSkillAutocomplete({
                discoverSkills: async () => {
                    throw new Error('catalog unavailable');
                },
                getSelectedSkills: () => [],
                onSelect: vi.fn(),
            })
        );

        await mounted.result.refresh('please use $code');
        await flushAsyncWork();

        expect(mounted.result.isOpen.value).toBe(false);
        expect(mounted.result.isLoading.value).toBe(false);
        expect(mounted.result.candidates.value).toEqual([]);
        expect(mounted.result.error.value).toBe(true);
        expect(mounted.result.query.value).toBe('code');
        expect(mounted.result.activeTrigger.value).toEqual({
            query: 'code',
            token: '$code',
            suffix: '',
        });

        errorSpy.mockRestore();
        mounted.unmount();
    });

    it('user navigates available skills and lets unrelated keys bubble', async () => {
        const mounted = await mountComposable(() =>
            useSkillAutocomplete({
                discoverSkills: async () => skills,
                getSelectedSkills: () => [],
                onSelect: vi.fn(),
            })
        );

        await mounted.result.refresh('please use $');
        await flushAsyncWork();

        const down = keyboardEvent('ArrowDown');
        expect(mounted.result.handleKeyDown(down.event)).toBe(true);
        expect(mounted.result.highlightedSkill.value?.name).toBe('code-quality-review');
        expect(mounted.result.handleKeyDown(keyboardEvent('ArrowDown').event)).toBe(true);
        expect(mounted.result.highlightedSkill.value?.name).toBe('ui-ux-pro-max');
        expect(down.preventDefault).toHaveBeenCalled();
        expect(down.stopPropagation).toHaveBeenCalled();

        const up = keyboardEvent('ArrowUp');
        expect(mounted.result.handleKeyDown(up.event)).toBe(true);
        expect(mounted.result.highlightedSkill.value?.name).toBe('code-quality-review');

        const shiftEnter = keyboardEvent('Enter', { shiftKey: true });
        expect(mounted.result.handleKeyDown(shiftEnter.event)).toBe(false);
        expect(shiftEnter.preventDefault).not.toHaveBeenCalled();

        const letter = keyboardEvent('a');
        expect(mounted.result.handleKeyDown(letter.event)).toBe(false);

        const escape = keyboardEvent('Escape');
        expect(mounted.result.handleKeyDown(escape.event)).toBe(true);
        expect(mounted.result.isOpen.value).toBe(false);

        mounted.unmount();
    });

    it('user keeps keyboard selection safe when no candidates are available', async () => {
        const onSelect = vi.fn();
        const mounted = await mountComposable(() =>
            useSkillAutocomplete({
                discoverSkills: async () => skills,
                getSelectedSkills: () => skills.map(({ name, path }) => ({ name, path })),
                onSelect,
            })
        );

        await mounted.result.refresh('please use $');
        await flushAsyncWork();

        expect(mounted.result.candidates.value).toEqual([]);
        expect(mounted.result.isOpen.value).toBe(true);
        expect(mounted.result.highlightedSkill.value).toBeNull();
        expect(mounted.result.handleKeyDown(keyboardEvent('ArrowDown').event)).toBe(true);
        expect(mounted.result.highlightedIndex.value).toBe(-1);
        const enter = keyboardEvent('Enter');
        expect(mounted.result.handleKeyDown(enter.event)).toBe(true);
        expect(enter.preventDefault).toHaveBeenCalled();
        expect(enter.stopPropagation).toHaveBeenCalled();
        expect(onSelect).not.toHaveBeenCalled();
        expect(mounted.result.isOpen.value).toBe(true);
        expect(mounted.result.activeTrigger.value).toEqual({ query: '', token: '$', suffix: '' });

        mounted.result.close();
        expect(mounted.result.handleKeyDown(keyboardEvent('Escape').event)).toBe(false);

        mounted.unmount();
    });

    it('user ignores direct selection when there is no active trigger', async () => {
        const onSelect = vi.fn();
        const mounted = await mountComposable(() =>
            useSkillAutocomplete({
                discoverSkills: async () => skills,
                getSelectedSkills: () => [],
                onSelect,
            })
        );

        mounted.result.selectSkill(skills[0]!);

        expect(onSelect).not.toHaveBeenCalled();
        mounted.unmount();
    });
});
