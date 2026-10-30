/**
 * Validates the model's scene plan before any of it is executed.
 *
 * The plan is untrusted: it is derived from a diff, a pull-request description,
 * and page text, any of which a contributor can write. Every action is
 * allowlisted, every click target must be a `data-testid` that the explore job
 * actually saw, and every string has a length cap.
 */

export const SURFACES = ['search', 'settings'];
export const ALLOWED_ACTIONS = [
    'bridge',
    'click',
    'hover',
    'type',
    'press',
    'scroll',
    'wait',
    'shot',
];
export const ALLOWED_BRIDGE_METHODS = ['openSettingsWindow', 'setSearchQuery'];
export const ALLOWED_KEYS = [
    'Enter',
    'Escape',
    'Tab',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Backspace',
];

export const LIMITS = {
    scenes: 5,
    stepsPerScene: 25,
    scenesWithShots: 12,
    selectorLength: 200,
    valueLength: 200,
    captionLength: 200,
    summaryLength: 600,
    scrollPixels: 2000,
    waitMs: 5000,
};

/**
 * A plan that only opens a window and takes one screenshot is not a preview: it
 * shows a single static state. These minimums reject that shape so the recorder
 * never produces a video with nothing happening in it.
 */
export const MINIMUMS = {
    interactionsPerScene: 3,
    shotsPerScene: 1,
    totalInteractions: 6,
    totalShots: 3,
};

const INTERACTIONS = ['bridge', 'click', 'hover', 'type', 'press', 'scroll'];

const SHOT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TEST_ID_SELECTOR = /^\[data-testid=['"]?([A-Za-z0-9_.:-]+)['"]?\]$/;

export function testIdFromSelector(selector) {
    const match = TEST_ID_SELECTOR.exec(String(selector ?? '').trim());
    return match ? match[1] : null;
}

function singleLine(value, maxLength) {
    return (
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= maxLength &&
        !/[\r\n]/.test(value)
    );
}

/**
 * @param {object} plan
 * @param {{ testIds?: Record<string, string[]>, surfaces?: string[] }} facts
 */
export function validatePlan(plan, facts = {}) {
    const errors = [];
    const testIds = facts.testIds ?? {};
    const surfaces = facts.surfaces ?? SURFACES;

    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
        return { ok: false, errors: ['the plan is not an object'], plan: null };
    }

    if (typeof plan.ui_change !== 'boolean') {
        errors.push('ui_change must be a boolean');
    }

    if (!singleLine(plan.summary, LIMITS.summaryLength)) {
        errors.push('summary must be one line of at most 600 characters');
    }

    if (plan.mismatch != null && typeof plan.mismatch !== 'string') {
        errors.push('mismatch must be a string');
    }

    if (plan.unseen != null && typeof plan.unseen !== 'string') {
        errors.push('unseen must be a string');
    }

    const scenes = Array.isArray(plan.scenes) ? plan.scenes : [];

    if (scenes.length === 0) {
        errors.push('scenes must contain at least one scene');
    }

    if (scenes.length > LIMITS.scenes) {
        errors.push(`at most ${LIMITS.scenes} scenes are allowed`);
    }

    let shotCount = 0;
    let interactionCount = 0;
    const accepted = [];

    scenes.forEach((scene, sceneIndex) => {
        const label = `scene ${sceneIndex + 1}`;

        if (!scene || typeof scene !== 'object') {
            errors.push(`${label} is not an object`);
            return;
        }

        if (!singleLine(scene.title, LIMITS.captionLength)) {
            errors.push(`${label} needs a one-line title`);
        }

        if (!surfaces.includes(scene.surface)) {
            errors.push(`${label} has an unknown surface`);
        }

        const steps = Array.isArray(scene.steps) ? scene.steps : [];

        if (steps.length === 0) {
            errors.push(`${label} has no steps`);
        }

        if (steps.length > LIMITS.stepsPerScene) {
            errors.push(`${label} has more than ${LIMITS.stepsPerScene} steps`);
        }

        const acceptedSteps = [];
        let sceneInteractions = 0;
        let sceneShots = 0;

        steps.forEach((step, stepIndex) => {
            const stepLabel = `${label} step ${stepIndex + 1}`;

            if (!step || typeof step !== 'object') {
                errors.push(`${stepLabel} is not an object`);
                return;
            }

            if (!ALLOWED_ACTIONS.includes(step.do)) {
                errors.push(`${stepLabel} uses an action that is not allowed`);
                return;
            }

            if (step.caption != null && !singleLine(step.caption, LIMITS.captionLength)) {
                errors.push(`${stepLabel} has an unusable caption`);
                return;
            }

            const known = testIds[scene.surface] ?? [];
            const needsTarget = ['click', 'hover', 'type'].includes(step.do);

            if (needsTarget) {
                if (!singleLine(step.target, LIMITS.selectorLength)) {
                    errors.push(`${stepLabel} needs a target selector`);
                    return;
                }

                const testId = testIdFromSelector(step.target);
                if (!testId) {
                    errors.push(`${stepLabel} must target a data-testid`);
                    return;
                }

                if (!known.includes(testId)) {
                    errors.push(`${stepLabel} targets a test id that this build does not render`);
                    return;
                }
            }

            if (step.do === 'type' && !singleLine(step.value, LIMITS.valueLength)) {
                errors.push(`${stepLabel} needs a one-line value`);
                return;
            }

            if (step.do === 'press' && !ALLOWED_KEYS.includes(step.value)) {
                errors.push(`${stepLabel} presses a key that is not allowed`);
                return;
            }

            if (step.do === 'scroll') {
                const pixels = Number(step.value);

                if (!Number.isFinite(pixels) || Math.abs(pixels) > LIMITS.scrollPixels) {
                    errors.push(
                        `${stepLabel} scrolls ${step.value}, outside the allowed -${LIMITS.scrollPixels} to ${LIMITS.scrollPixels}`
                    );
                    return;
                }
            }

            if (step.do === 'wait') {
                const ms = Number(step.value);

                if (!Number.isFinite(ms) || ms < 0 || ms > LIMITS.waitMs) {
                    errors.push(
                        `${stepLabel} waits ${step.value}ms, outside the allowed 0 to ${LIMITS.waitMs}`
                    );
                    return;
                }
            }

            if (step.do === 'bridge') {
                if (!ALLOWED_BRIDGE_METHODS.includes(step.value)) {
                    errors.push(`${stepLabel} calls a bridge method that is not allowed`);
                    return;
                }

                const args = step.args ?? [];

                if (
                    !Array.isArray(args) ||
                    args.length > 3 ||
                    args.some((arg) => typeof arg !== 'string' || arg.length > LIMITS.valueLength)
                ) {
                    errors.push(`${stepLabel} has unusable bridge arguments`);
                    return;
                }
            }

            if (step.do === 'shot') {
                if (!SHOT_NAME.test(String(step.name ?? ''))) {
                    errors.push(
                        `${stepLabel} needs a shot name of lowercase letters, digits, and dashes`
                    );
                    return;
                }

                if (step.target != null) {
                    const testId = testIdFromSelector(step.target);

                    if (!singleLine(step.target, LIMITS.selectorLength) || !testId) {
                        errors.push(`${stepLabel} must target a data-testid to crop to`);
                        return;
                    }

                    if (!known.includes(testId)) {
                        errors.push(
                            `${stepLabel} targets a test id that this build does not render`
                        );
                        return;
                    }
                }

                shotCount += 1;
                sceneShots += 1;

                if (shotCount > LIMITS.scenesWithShots) {
                    errors.push(`at most ${LIMITS.scenesWithShots} screenshots are allowed`);
                    return;
                }
            }

            if (INTERACTIONS.includes(step.do)) {
                interactionCount += 1;
                sceneInteractions += 1;
            }

            acceptedSteps.push(step);
        });

        if (sceneInteractions < MINIMUMS.interactionsPerScene) {
            errors.push(
                `${label} needs at least ${MINIMUMS.interactionsPerScene} interactions so the recording shows a flow`
            );
        }

        if (sceneShots < MINIMUMS.shotsPerScene) {
            errors.push(`${label} needs at least ${MINIMUMS.shotsPerScene} screenshot`);
        }

        if (acceptedSteps.length > 0) {
            accepted.push({ ...scene, steps: acceptedSteps });
        }
    });

    if (interactionCount < MINIMUMS.totalInteractions) {
        errors.push(
            `the plan needs at least ${MINIMUMS.totalInteractions} interactions, not ${interactionCount}`
        );
    }

    if (shotCount < MINIMUMS.totalShots) {
        errors.push(`the plan needs at least ${MINIMUMS.totalShots} screenshots, not ${shotCount}`);
    }

    return {
        ok: errors.length === 0,
        errors,
        plan: errors.length === 0 ? { ...plan, scenes: accepted } : null,
    };
}

/**
 * A deterministic plan for when the model is unavailable or its answer is
 * rejected. It always produces evidence for the surfaces the diff touched.
 */
export function defaultPlan(facts = {}) {
    const scenes = [];
    const touchedSettings = Boolean(facts.touchedSettings);
    const touchedSearch = Boolean(facts.touchedSearch);
    const wantsSettings = touchedSettings || !touchedSearch;
    const wantsSearch = touchedSearch || !touchedSettings;
    const testIds = facts.testIds ?? {};
    const has = (surface, id) => {
        const ids = testIds[surface];
        return !ids || ids.includes(id);
    };

    if (wantsSearch) {
        const query = 'touchai';
        const typed = [...query].map((_, index) => ({
            do: 'bridge',
            value: 'setSearchQuery',
            args: [query.slice(0, index + 1)],
        }));

        scenes.push({
            title: 'Search',
            surface: 'search',
            steps: [
                {
                    do: 'click',
                    target: "[data-testid='search-editor-host']",
                    caption: 'Focus the search bar',
                },
                ...typed,
                {
                    do: 'wait',
                    value: 800,
                    caption: 'Wait for the result',
                },
                {
                    do: 'shot',
                    name: 'search-query',
                    caption: 'Search window with a query',
                },
                {
                    do: 'bridge',
                    value: 'setSearchQuery',
                    args: ['touchai settings'],
                    caption: 'Refine the query',
                },
                { do: 'wait', value: 800 },
                {
                    do: 'shot',
                    name: 'search-refined',
                    caption: 'Search window after refining the query',
                },
            ],
        });
    }

    if (wantsSettings) {
        const steps = [
            { do: 'bridge', value: 'openSettingsWindow', caption: 'Open Settings' },
            { do: 'wait', value: 600 },
            {
                do: 'shot',
                name: 'settings-general',
                caption: 'Settings opens on General',
            },
        ];

        if (has('settings', 'settings-nav-shortcuts')) {
            steps.push(
                {
                    do: 'click',
                    target: "[data-testid='settings-nav-shortcuts']",
                    caption: 'Open Shortcuts',
                },
                { do: 'wait', value: 500 },
                {
                    do: 'shot',
                    name: 'settings-shortcuts',
                    caption: 'Shortcuts section',
                },
                {
                    do: 'scroll',
                    value: 700,
                    caption: 'Scroll the shortcut list',
                },
                { do: 'wait', value: 500 },
                {
                    do: 'shot',
                    name: 'settings-shortcuts-scrolled',
                    caption: 'Shortcuts section, scrolled',
                }
            );
        }

        if (has('settings', 'settings-nav-search')) {
            steps.push(
                {
                    do: 'click',
                    target: "[data-testid='settings-nav-search']",
                    caption: 'Open Search settings',
                },
                { do: 'wait', value: 500 },
                {
                    do: 'shot',
                    name: 'settings-search',
                    caption: 'Search settings',
                }
            );

            if (has('settings', 'search-enabled-toggle')) {
                steps.push(
                    {
                        do: 'click',
                        target: "[data-testid='search-enabled-toggle']",
                        caption: 'Toggle search',
                    },
                    { do: 'wait', value: 400 },
                    {
                        do: 'shot',
                        name: 'settings-search-toggled',
                        caption: 'Search toggled off',
                    },
                    {
                        do: 'click',
                        target: "[data-testid='search-enabled-toggle']",
                        caption: 'Restore search',
                    }
                );
            }
        }

        if (has('settings', 'settings-nav-usage')) {
            steps.push(
                {
                    do: 'click',
                    target: "[data-testid='settings-nav-usage']",
                    caption: 'Open Usage',
                },
                { do: 'wait', value: 600 },
                {
                    do: 'shot',
                    name: 'settings-usage',
                    caption: 'Usage dashboard',
                }
            );
        }

        scenes.push({
            title: 'Settings',
            surface: 'settings',
            steps,
        });
    }

    return {
        ui_change: true,
        summary: 'The diff changes interface files; the default scene shows the affected surfaces.',
        mismatch: '',
        unseen: '',
        scenes,
        source: 'default',
    };
}

const RESULT_CLAIM = /\b(?:expanded|results?|content\s+height)\b/i;

export const COMPACT_SEARCH_CAPTION = 'Compact search window; no results panel is visible';

export function accurateSearchCaption(caption, expanded) {
    const value = String(caption ?? '').trim();

    if (expanded || !RESULT_CLAIM.test(value)) {
        return value;
    }

    return COMPACT_SEARCH_CAPTION;
}
