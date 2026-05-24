import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';

import { setLocale } from '@/i18n';
import { createDomLocalizer } from '@/i18n/domLocalizer';
import CustomSelect from '@/components/CustomSelect.vue';
import SearchableSelect from '@/components/SearchableSelect.vue';
import ToolLogContent from '@/components/ToolLogContent.vue';
import QuickSearchPanel from '@/views/SearchView/components/QuickSearchPanel/index.vue';
import ToolCallSection from '@/views/SearchView/components/ConversationPanel/components/ToolCallSection.vue';

const { useQuickSearchLogicMock } = vi.hoisted(() => ({
    useQuickSearchLogicMock: vi.fn(),
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        props: ['name'],
        template: '<span data-testid="app-icon" />',
    },
}));

vi.mock('@components/ui/select', () => ({
    Select: {
        name: 'Select',
        props: ['modelValue', 'open', 'disabled'],
        emits: ['update:modelValue', 'update:open'],
        template: '<div data-testid="select-root"><slot /></div>',
    },
    SelectContent: {
        name: 'SelectContent',
        template: '<div data-testid="select-content"><slot /></div>',
    },
    SelectItem: {
        name: 'SelectItem',
        props: ['value'],
        template: '<div data-testid="select-item"><slot /></div>',
    },
    SelectTrigger: {
        name: 'SelectTrigger',
        props: ['disabled', 'iconClass'],
        template: '<button type="button" data-testid="select-trigger" :disabled="disabled"><slot /></button>',
    },
    SelectValue: {
        name: 'SelectValue',
        props: ['placeholder'],
        template: '<span data-testid="select-value">{{ placeholder }}</span>',
    },
}));

vi.mock(
    '@/views/SearchView/components/QuickSearchPanel/composables/useQuickSearchLogic',
    () => ({
        useQuickSearchLogic: useQuickSearchLogicMock,
    })
);

vi.mock(
    '@/views/SearchView/components/ConversationPanel/components/ToolCallItem.vue',
    () => ({
        default: {
            name: 'ToolCallItem',
            props: ['toolCall'],
            template: '<div data-testid="tool-call-item" />',
        },
    })
);

describe('dynamic payload DOM localizer boundaries', () => {
    let localizer: ReturnType<typeof createDomLocalizer> | null = null;

    beforeEach(() => {
        vi.clearAllMocks();
        setLocale('en-US');
    });

    afterEach(() => {
        localizer?.stop();
        localizer = null;
        document.body.innerHTML = '';
        setLocale('zh-CN');
    });

    it('translates ToolLogContent labels while leaving input, output, and error payload untouched', () => {
        const wrapper = mount(ToolLogContent, {
            props: {
                input: JSON.stringify({ query: '设置' }),
                output: JSON.stringify({ value: '工具' }),
                error: '错误',
            },
            attachTo: document.body,
        });

        localizer = createDomLocalizer(document.body);
        localizer.translateNow();

        expect(wrapper.text()).toContain('Input');
        expect(wrapper.text()).toContain('Result');
        expect(wrapper.text()).toContain('设置');
        expect(wrapper.text()).toContain('工具');
        expect(wrapper.text()).toContain('错误');
        expect(wrapper.get('pre').attributes('data-no-i18n')).toBe('true');
        expect(wrapper.get('pre').attributes('translate')).toBe('no');
    });

    it('translates ToolCallSection status text while leaving the latest tool name untouched', () => {
        const wrapper = mount(ToolCallSection, {
            props: {
                messageContent: '',
                toolCalls: [
                    {
                        id: 'tool-call-1',
                        name: '工具',
                        namespacedName: 'builtin__setting',
                        source: 'builtin',
                        arguments: {},
                        status: 'completed',
                    },
                ],
            },
            attachTo: document.body,
        });

        localizer = createDomLocalizer(document.body);
        localizer.translateNow();

        expect(wrapper.text()).toContain('Tool calls (1)');
        expect(wrapper.text()).toContain('Completed');
        const latestName = wrapper.get('.tool-call-inline-latest');
        expect(latestName.text()).toBe('工具');
        expect(latestName.attributes('data-no-i18n')).toBe('true');
        expect(latestName.attributes('translate')).toBe('no');
    });

    it('leaves QuickSearchPanel result names, titles, and alt text untouched', () => {
        useQuickSearchLogicMock.mockReturnValue({
            results: ref([
                {
                    name: '设置',
                    path: 'C:/Users/Public/Desktop/settings.lnk',
                    source: 'desktop_user',
                },
            ]),
            highlightedIndex: ref(0),
            itemRefs: ref([]),
            scrollRef: ref(null),
            scrollStyle: ref({}),
            gridStyle: ref({}),
            moveSelection: vi.fn(),
            iconMap: ref({
                'C:/Users/Public/Desktop/settings.lnk': 'icon.png',
            }),
            imagePreviewMap: ref({}),
            isImageItem: vi.fn(() => false),
            getItemHoverTitle: vi.fn(() => '设置'),
            handleScroll: vi.fn(),
            getNameSegments: vi.fn((name: string) => [{ text: name, matched: false }]),
            handleItemClick: vi.fn(),
            open: vi.fn(),
            close: vi.fn(),
            syncClosedState: vi.fn(),
            getHighlightedItem: vi.fn(),
            openHighlightedItem: vi.fn(),
            triggerSearch: vi.fn(),
        });

        const wrapper = mount(QuickSearchPanel, {
            props: {
                open: true,
                searchQuery: 'set',
            },
            attachTo: document.body,
        });

        localizer = createDomLocalizer(document.body);
        localizer.translateNow();

        const resultButton = wrapper.get('button');
        expect(resultButton.text()).toContain('设置');
        expect(resultButton.attributes('title')).toBe('设置');
        expect(resultButton.attributes('data-no-i18n')).toBe('true');
        expect(resultButton.get('img').attributes('alt')).toBe('设置');
        expect(wrapper.text()).not.toContain('Settings');
    });

    it('renders shared select default placeholders in the active locale without DOM-localizer fallback', async () => {
        const searchable = mount(SearchableSelect, {
            props: {
                modelValue: null,
                options: [],
            },
        });

        expect(searchable.get('button').text()).toContain('Select');
        await searchable.get('button').trigger('click');
        await nextTick();
        expect(searchable.get('input').attributes('placeholder')).toBe('Search');
        expect(searchable.text()).toContain('No options');

        const custom = mount(CustomSelect, {
            props: {
                modelValue: '',
                options: [],
            },
        });

        expect(custom.get('[data-testid="select-value"]').text()).toBe('Select');
    });

    it('protects SearchableSelect option labels and descriptions when opted in', async () => {
        const wrapper = mount(SearchableSelect, {
            props: {
                modelValue: 'settings',
                options: [
                    {
                        value: 'settings',
                        label: '设置',
                        description: '描述',
                    },
                ],
                searchPlaceholder: '搜索模型名称、ID 或供应商',
                protectOptionText: true,
            },
            attachTo: document.body,
        });

        await wrapper.get('button').trigger('click');
        await nextTick();
        localizer = createDomLocalizer(document.body);
        localizer.translateNow();

        expect(wrapper.text()).toContain('设置');
        expect(wrapper.text()).toContain('描述');
        expect(wrapper.text()).not.toContain('Settings');
        expect(wrapper.text()).not.toContain('No description');
        expect(wrapper.get('[data-no-i18n="true"]').attributes('translate')).toBe('no');
        expect(wrapper.get('input').attributes('placeholder')).toBe(
            'Search model name, ID, or provider'
        );
    });

    it('protects CustomSelect option labels, descriptions, and image alt text when opted in', () => {
        const wrapper = mount(CustomSelect, {
            props: {
                modelValue: 'settings',
                options: [
                    {
                        value: 'settings',
                        label: '设置',
                        description: '描述',
                        iconSrc: 'icon.png',
                    },
                ],
                protectOptionText: true,
            },
            attachTo: document.body,
        });

        localizer = createDomLocalizer(document.body);
        localizer.translateNow();

        expect(wrapper.text()).toContain('设置');
        expect(wrapper.text()).toContain('描述');
        expect(wrapper.text()).not.toContain('Settings');
        expect(wrapper.text()).not.toContain('No description');
        expect(wrapper.get('img').attributes('alt')).toBe('设置');
        expect(wrapper.get('img').attributes('data-no-i18n')).toBe('true');
        expect(wrapper.get('img').attributes('translate')).toBe('no');
    });
});
