import {
    homepageDemoScenarios,
    type HomepageDemoLocale,
} from '../data/homepage-demo-scenarios';
import type {
    HomepageDemoReplayScenarioId,
    HomepageDemoScenarioId,
} from '../components/homepage-demo/scenario-types';

type HomepageDemoHost = HTMLElement & {
    dataset: DOMStringMap & {
        scenarioId?: HomepageDemoScenarioId;
        src?: string;
        title?: string;
    };
    reload?: () => Promise<void>;
};

const homepageDemoScenarioIds: HomepageDemoScenarioId[] = [
    'intro',
    'solver',
    'work-organizer',
    'reminder',
];

const homepageDemoReplayScenarioIds: HomepageDemoReplayScenarioId[] = [
    'solver',
    'work-organizer',
    'reminder',
];

export const syncHomepageDemoLocale = ({
    document,
    lang,
    replayLabels,
    replaySuffix,
    resetDemoProgressDedupe,
    syncComponentBackground,
    restoreFeatureDemoProgress,
}: {
    document: Document;
    lang: HomepageDemoLocale;
    replayLabels: Record<'solver' | 'work' | 'reminder', string>;
    replaySuffix: string;
    resetDemoProgressDedupe: (frame: HomepageDemoHost) => void;
    syncComponentBackground: () => void;
    restoreFeatureDemoProgress: (frame: HomepageDemoHost) => void;
}) => {
    homepageDemoReplayScenarioIds.forEach((scenarioId) => {
        const selector = homepageDemoScenarios[scenarioId].replayCardSelector;
        if (!selector) return;

        const labelKey =
            scenarioId === 'solver'
                ? 'solver'
                : scenarioId === 'work-organizer'
                  ? 'work'
                  : 'reminder';
        const card = document.querySelector<HTMLElement>(selector);
        if (!card) return;

        card.setAttribute(
            'aria-label',
            `${replayLabels[labelKey]}，${replaySuffix}`.replace('，，', '，')
        );
        if (lang === 'en') {
            card.setAttribute('aria-label', `${replayLabels[labelKey]}, ${replaySuffix}`);
        }
    });

    homepageDemoScenarioIds.forEach((scenarioId) => {
        const frame = document.querySelector<HomepageDemoHost>(`[data-scenario-id="${scenarioId}"]`);
        if (!frame) return;

        const variant = homepageDemoScenarios[scenarioId].variants[lang];
        if (frame.dataset.src === variant.src) return;

        resetDemoProgressDedupe(frame);
        frame.dataset.src = variant.src;
        frame.dataset.title = variant.title;

        void Promise.resolve(frame.reload?.()).then(() => {
            syncComponentBackground();
            if (homepageDemoScenarios[scenarioId].restoreProgressOnReload) {
                restoreFeatureDemoProgress(frame);
            }
        });
    });
};
