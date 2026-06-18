import type { HomepageDemoScenarioId } from '../components/homepage-demo/scenario-types';

export type HomepageDemoLocale = 'zh' | 'en';

export interface HomepageDemoVariant {
    src: string;
    title: string;
}

export interface HomepageDemoScenario {
    id: HomepageDemoScenarioId;
    frameClassName: string;
    replayCardSelector?: string;
    replayLabels?: Record<HomepageDemoLocale, string>;
    restoreProgressOnReload?: boolean;
    variants: Record<HomepageDemoLocale, HomepageDemoVariant>;
}

export const homepageDemoScenarios: Record<HomepageDemoScenarioId, HomepageDemoScenario> = {
    intro: {
        id: 'intro',
        frameClassName: 'component-frame',
        variants: {
            zh: {
                src: '/touchai-intro/touchai-components.html?v=8',
                title: 'TouchAI 介绍组件演示',
            },
            en: {
                src: '/touchai-intro-en/touchai-components.html?v=1',
                title: 'TouchAI intro component demo',
            },
        },
    },
    solver: {
        id: 'solver',
        frameClassName: 'feature-component-frame',
        replayCardSelector: '.feature-component-card',
        replayLabels: {
            zh: '解题对话框',
            en: 'Math solver conversation',
        },
        restoreProgressOnReload: true,
        variants: {
            zh: {
                src: '/feature-solver/touchai-components.html?v=17',
                title: 'TouchAI 解题组件演示',
            },
            en: {
                src: '/feature-solver-en/touchai-components.html?v=1',
                title: 'TouchAI math solver component demo',
            },
        },
    },
    'work-organizer': {
        id: 'work-organizer',
        frameClassName: 'feature-work-frame',
        replayCardSelector: '.feature-work-card',
        replayLabels: {
            zh: '工作整理对话框',
            en: 'Work organizer conversation',
        },
        restoreProgressOnReload: true,
        variants: {
            zh: {
                src: '/feature-work-organizer/touchai-components.html?v=13',
                title: 'TouchAI 工作整理组件演示',
            },
            en: {
                src: '/feature-work-organizer-en/touchai-components.html?v=1',
                title: 'TouchAI work organizer component demo',
            },
        },
    },
    reminder: {
        id: 'reminder',
        frameClassName: 'feature-reminder-frame',
        replayCardSelector: '.feature-reminder-card',
        replayLabels: {
            zh: '提醒对话框',
            en: 'Reminder conversation',
        },
        restoreProgressOnReload: true,
        variants: {
            zh: {
                src: '/feature-reminder/touchai-components.html?v=5',
                title: 'TouchAI MCP 工具调用组件演示',
            },
            en: {
                src: '/feature-reminder-en/touchai-components.html?v=1',
                title: 'TouchAI meeting reminder component demo',
            },
        },
    },
};

export const homepageDemoScenarioList = Object.values(homepageDemoScenarios);
