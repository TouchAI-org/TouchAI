import type { AppIconName } from '@components/appIconMap';

import { type MessageKey, t } from '@/i18n';
import { JSON_SETTINGS_SECTIONS } from '@/stores/setting/sections/registry';

export type NavigationSection =
    | 'general'
    | 'ai-services'
    | 'built-in-tools'
    | 'search'
    | 'browser'
    | 'mcp-tools'
    | 'data-management';

export interface SettingsNavigationItem {
    id: NavigationSection;
    icon: AppIconName;
    label: string;
    description: string;
}

export interface SettingsNavigationGroup {
    label: string;
    items: SettingsNavigationItem[];
}

interface SettingsNavigationItemDefinition {
    id: NavigationSection;
    icon: AppIconName;
    labelKey: MessageKey;
    descriptionKey: MessageKey;
}

interface SettingsNavigationGroupDefinition {
    labelKey: MessageKey;
    items: SettingsNavigationItemDefinition[];
}

const jsonSettingsNavigationDefinitions: SettingsNavigationItemDefinition[] = [
    ...JSON_SETTINGS_SECTIONS,
]
    .sort((left, right) => left.ui.navigationOrder - right.ui.navigationOrder)
    .map((section) => ({
        id: section.ui.sectionId,
        icon: section.ui.icon,
        labelKey: section.ui.labelKey,
        descriptionKey: section.ui.descriptionKey,
    }));

const settingsNavigationDefinitions: SettingsNavigationGroupDefinition[] = [
    {
        labelKey: 'settings.nav.group.basicExperience',
        items: [
            {
                id: 'general',
                icon: 'settings',
                labelKey: 'settings.nav.general.label',
                descriptionKey: 'settings.nav.general.description',
            },
        ],
    },
    {
        labelKey: 'settings.nav.group.aiCapability',
        items: [
            {
                id: 'ai-services',
                icon: 'llm',
                labelKey: 'settings.nav.aiServices.label',
                descriptionKey: 'settings.nav.aiServices.description',
            },
            {
                id: 'built-in-tools',
                icon: 'wrench',
                labelKey: 'settings.nav.builtInTools.label',
                descriptionKey: 'settings.nav.builtInTools.description',
            },
            ...jsonSettingsNavigationDefinitions,
            {
                id: 'mcp-tools',
                icon: 'mcp',
                labelKey: 'settings.nav.mcpTools.label',
                descriptionKey: 'settings.nav.mcpTools.description',
            },
        ],
    },
    {
        labelKey: 'settings.nav.group.system',
        items: [
            {
                id: 'data-management',
                icon: 'database',
                labelKey: 'settings.nav.dataManagement.label',
                descriptionKey: 'settings.nav.dataManagement.description',
            },
        ],
    },
];

function createNavigationItem(
    definition: SettingsNavigationItemDefinition
): SettingsNavigationItem {
    return {
        id: definition.id,
        icon: definition.icon,
        get label() {
            return t(definition.labelKey);
        },
        get description() {
            return t(definition.descriptionKey);
        },
    };
}

export const settingsNavigationGroups: SettingsNavigationGroup[] =
    settingsNavigationDefinitions.map((group) => ({
        get label() {
            return t(group.labelKey);
        },
        items: group.items.map(createNavigationItem),
    }));

export function flattenSettingsNavigation(): SettingsNavigationItem[] {
    return settingsNavigationGroups.flatMap((group) => group.items);
}

export function getSettingsNavigationItem(
    section: NavigationSection
): SettingsNavigationItem | undefined {
    return flattenSettingsNavigation().find((item) => item.id === section);
}
