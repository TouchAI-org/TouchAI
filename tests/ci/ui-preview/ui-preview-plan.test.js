import { describe, expect, it } from 'vitest';

import {
    defaultPlan,
    testIdFromSelector,
    validatePlan,
} from '../../../.github/ui-preview/lib/scenarios.mjs';

const facts = {
    testIds: {
        search: ['search-view', 'search-bar', 'quick-search-panel'],
        settings: [
            'settings-view',
            'settings-nav-shortcuts',
            'settings-nav-search',
            'settings-shortcuts-section',
        ],
    },
};

function planWithSteps(steps, surface = 'settings') {
    return {
        ui_change: true,
        summary: 'The shortcuts section groups its rows.',
        mismatch: '',
        unseen: '',
        scenes: [{ title: 'Shortcuts', surface, steps }],
    };
}

describe('user reads a plan from the model', () => {
    it('user gets a valid plan when every action and target is known', () => {
        const result = validatePlan(
            planWithSteps([
                { do: 'click', target: "[data-testid='settings-nav-shortcuts']" },
                { do: 'click', target: "[data-testid='settings-nav-search']" },
                { do: 'click', target: "[data-testid='settings-nav-shortcuts']" },
                { do: 'click', target: "[data-testid='settings-nav-search']" },
                { do: 'click', target: "[data-testid='settings-nav-shortcuts']" },
                { do: 'click', target: "[data-testid='settings-nav-search']" },
                { do: 'shot', name: 'shortcuts' },
                { do: 'shot', name: 'search-settings' },
                { do: 'shot', name: 'back-to-shortcuts' },
            ]),
            facts
        );

        expect(result.ok).toBe(true);
        expect(result.plan.scenes).toHaveLength(1);
    });

    it('user gets a rejection when the plan targets an element the build does not render', () => {
        const result = validatePlan(
            planWithSteps([{ do: 'click', target: "[data-testid='not-rendered']" }]),
            facts
        );

        expect(result.ok).toBe(false);
        expect(result.errors.join(' ')).toContain('does not render');
    });

    it('user gets a rejection when the plan uses a raw css selector', () => {
        const result = validatePlan(planWithSteps([{ do: 'click', target: 'body > div' }]), facts);

        expect(result.ok).toBe(false);
        expect(result.errors.join(' ')).toContain('data-testid');
    });

    it('user gets a rejection when the plan uses an action outside the allowlist', () => {
        const result = validatePlan(planWithSteps([{ do: 'shell', value: 'rm -rf /' }]), facts);

        expect(result.ok).toBe(false);
        expect(result.errors.join(' ')).toContain('not allowed');
    });

    it('user gets a rejection when the plan calls a bridge method that is not exposed', () => {
        const result = validatePlan(planWithSteps([{ do: 'bridge', value: 'quit' }]), facts);

        expect(result.ok).toBe(false);
    });

    it('user gets a rejection when the plan presses a key that is not allowed', () => {
        const result = validatePlan(planWithSteps([{ do: 'press', value: 'F12' }]), facts);

        expect(result.ok).toBe(false);
    });

    it('user gets a rejection when a shot name could escape the evidence directory', () => {
        const result = validatePlan(planWithSteps([{ do: 'shot', name: '../escape' }]), facts);

        expect(result.ok).toBe(false);
    });

    it('user gets a rejection when the plan has too many scenes', () => {
        const scene = { title: 'A', surface: 'settings', steps: [{ do: 'shot', name: 'a' }] };
        const result = validatePlan(
            {
                ui_change: true,
                summary: 'x',
                scenes: Array.from({ length: 6 }, () => ({ ...scene })),
            },
            facts
        );

        expect(result.ok).toBe(false);
        expect(result.errors.join(' ')).toContain('at most 5 scenes');
    });

    it('user gets a rejection when a caption spans multiple lines', () => {
        const result = validatePlan(
            planWithSteps([{ do: 'shot', name: 'a', caption: 'line one\nline two' }]),
            facts
        );

        expect(result.ok).toBe(false);
    });

    it('user gets a rejection when a scene only opens a window and takes one screenshot', () => {
        const result = validatePlan(planWithSteps([{ do: 'shot', name: 'only-frame' }]), facts);

        expect(result.ok).toBe(false);
        expect(result.errors.join(' ')).toContain('at least 3 interactions');
    });

    it('user gets a rejection when the whole plan has too little to watch', () => {
        const result = validatePlan(
            {
                ui_change: true,
                summary: 'x',
                scenes: [
                    {
                        title: 'A',
                        surface: 'settings',
                        steps: [
                            { do: 'click', target: "[data-testid='settings-nav-shortcuts']" },
                            { do: 'click', target: "[data-testid='settings-nav-search']" },
                            { do: 'shot', name: 'a' },
                        ],
                    },
                ],
            },
            facts
        );

        expect(result.ok).toBe(false);
        expect(result.errors.join(' ')).toContain('at least 6 interactions');
    });
});

describe('user falls back to a deterministic plan', () => {
    it('user sees the search window when only the search view changed', () => {
        const plan = defaultPlan({ touchedSearch: true, touchedSettings: false });

        expect(plan.scenes.map((scene) => scene.surface)).toEqual(['search']);
        expect(plan.scenes[0].steps.filter((step) => step.do === 'shot').length).toBeGreaterThan(1);
        expect(
            plan.scenes[0].steps.filter((step) =>
                ['bridge', 'click', 'type', 'press', 'scroll'].includes(step.do)
            ).length
        ).toBeGreaterThan(3);
    });

    it('user sees the settings window when only settings changed', () => {
        const plan = defaultPlan({ touchedSearch: false, touchedSettings: true });

        expect(plan.scenes.map((scene) => scene.surface)).toEqual(['settings']);
        expect(plan.scenes[0].steps.filter((step) => step.do === 'shot').length).toBeGreaterThan(2);
    });

    it('user sees both surfaces when the change is shared', () => {
        const plan = defaultPlan({ touchedSearch: false, touchedSettings: false });

        expect(plan.scenes.map((scene) => scene.surface)).toEqual(['search', 'settings']);
        expect(plan.source).toBe('default');
    });
});

describe('user targets an element by test id', () => {
    it('user gets the id from the quoted selector', () => {
        expect(testIdFromSelector("[data-testid='search-bar']")).toBe('search-bar');
    });

    it('user gets the id from the unquoted selector', () => {
        expect(testIdFromSelector('[data-testid=search-bar]')).toBe('search-bar');
    });

    it('user gets nothing from a compound selector', () => {
        expect(testIdFromSelector("[data-testid='a'] .child")).toBeNull();
    });
});

describe('user asks for a cropped screenshot', () => {
    const steps = [
        { do: 'click', target: "[data-testid='settings-nav-shortcuts']" },
        { do: 'click', target: "[data-testid='settings-nav-search']" },
        { do: 'click', target: "[data-testid='settings-nav-shortcuts']" },
        { do: 'click', target: "[data-testid='settings-nav-search']" },
        { do: 'click', target: "[data-testid='settings-nav-shortcuts']" },
        { do: 'click', target: "[data-testid='settings-nav-search']" },
        {
            do: 'shot',
            name: 'shortcuts',
            target: "[data-testid='settings-shortcuts-section']",
        },
        { do: 'shot', name: 'search', target: "[data-testid='settings-nav-search']" },
        { do: 'shot', name: 'general' },
    ];

    it('user gets a shot cropped to a test id that the build renders', () => {
        expect(validatePlan(planWithSteps(steps), facts).ok).toBe(true);
    });

    it('user gets a rejection when the shot targets an id the build never rendered', () => {
        const result = validatePlan(
            planWithSteps(
                steps.map((step) =>
                    step.name === 'shortcuts'
                        ? { ...step, target: "[data-testid='settings-missing-section']" }
                        : step
                )
            ),
            facts
        );

        expect(result.ok).toBe(false);
        expect(result.errors.join(' ')).toContain('this build does not render');
    });

    it('user gets a rejection when the shot target is not a test id', () => {
        const result = validatePlan(
            planWithSteps(
                steps.map((step) =>
                    step.name === 'shortcuts' ? { ...step, target: '.settings-section' } : step
                )
            ),
            facts
        );

        expect(result.ok).toBe(false);
        expect(result.errors.join(' ')).toContain('must target a data-testid');
    });
});
