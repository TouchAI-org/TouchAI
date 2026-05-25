import type { AppIconName } from '@components/appIconMap';

export type NavigationSection =
    | 'general'
    | 'ai-services'
    | 'built-in-tools'
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

export const settingsNavigationGroups: SettingsNavigationGroup[] = [
    {
        label: '基础体验',
        items: [
            {
                id: 'general',
                icon: 'settings',
                label: '通用',
                description: '快捷键、启动、对话和窗口偏好',
            },
        ],
    },
    {
        label: 'AI 能力',
        items: [
            {
                id: 'ai-services',
                icon: 'llm',
                label: '服务商与模型',
                description: 'Provider、模型、默认模型和密钥',
            },
            {
                id: 'built-in-tools',
                icon: 'tool',
                label: '内置工具',
                description: '应用自带工具的启用、配置和日志',
            },
            {
                id: 'mcp-tools',
                icon: 'mcp',
                label: 'MCP 工具',
                description: '外部 MCP 服务器与工具调用日志',
            },
        ],
    },
    {
        label: '系统',
        items: [
            {
                id: 'data-management',
                icon: 'database',
                label: '数据管理',
                description: '统计、备份、导入和模型元数据',
            },
        ],
    },
];

export function flattenSettingsNavigation(): SettingsNavigationItem[] {
    return settingsNavigationGroups.flatMap((group) => group.items);
}

export function getSettingsNavigationItem(
    section: NavigationSection
): SettingsNavigationItem | undefined {
    return flattenSettingsNavigation().find((item) => item.id === section);
}
