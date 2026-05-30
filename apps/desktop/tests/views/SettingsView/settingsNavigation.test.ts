import {
    flattenSettingsNavigation,
    getSettingsNavigationItem,
    settingsNavigationGroups,
} from '@/views/SettingsView/settingsNavigation';

describe('settingsNavigation', () => {
    it('starts with general and exposes the expected section labels', () => {
        const items = flattenSettingsNavigation();

        expect(items[0]).toMatchObject({
            id: 'general',
            label: '通用',
        });
        expect(items.map((item) => item.label)).toEqual([
            '通用',
            '服务商与模型',
            '模型设置',
            '内置工具',
            'MCP 工具',
            '数据管理',
        ]);
    });

    it('keeps navigation groups focused and searchable by section id', () => {
        expect(settingsNavigationGroups.map((group) => group.label)).toEqual([
            '基础体验',
            'AI 能力',
            '系统',
        ]);

        expect(getSettingsNavigationItem('ai-services')).toMatchObject({
            label: '服务商与模型',
            icon: 'cloud',
        });
        expect(getSettingsNavigationItem('model-preferences')).toMatchObject({
            label: '模型设置',
            icon: 'llm',
        });
        expect(getSettingsNavigationItem('general')?.description).toContain('快捷键');
        expect(getSettingsNavigationItem('overview' as never)).toBeUndefined();
        expect(getSettingsNavigationItem('about' as never)).toBeUndefined();
    });
});
