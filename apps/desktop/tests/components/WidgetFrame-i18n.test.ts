import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import type { WidgetInfo } from '@/types/session';
import WidgetFrame from '@/views/SearchView/components/ConversationPanel/components/WidgetFrame.vue';

const { createWidgetRendererMock, destroyMock, renderMock } = vi.hoisted(() => ({
    createWidgetRendererMock: vi.fn(),
    destroyMock: vi.fn(),
    renderMock: vi.fn(),
}));

vi.mock('@/services/BuiltInToolService/tools/widgetTool', () => ({
    createWidgetRenderer: createWidgetRendererMock,
}));

function createWidget(overrides: Partial<WidgetInfo> = {}): WidgetInfo {
    return {
        id: 'widget-entity-1',
        callId: 'call-1',
        widgetId: 'widget-1',
        title: '销售图表',
        description: '季度销售数据',
        html: '<div>设置</div>',
        mode: 'render',
        phase: 'draft',
        updatedAt: Date.now(),
        ...overrides,
    };
}

describe('WidgetFrame i18n boundaries', () => {
    it('marks the widget host as not eligible for global DOM localization', () => {
        createWidgetRendererMock.mockReturnValue({
            render: renderMock,
            destroy: destroyMock,
        });

        const wrapper = mount(WidgetFrame, {
            props: {
                widget: createWidget(),
            },
        });

        expect(wrapper.attributes('data-no-i18n')).toBe('true');
        expect(wrapper.attributes('translate')).toBe('no');
        expect(wrapper.attributes('data-widget-phase')).toBe('draft');
        expect(wrapper.attributes('title')).toBe('销售图表');
        expect(createWidgetRendererMock).toHaveBeenCalledWith(wrapper.element);
        expect(renderMock).toHaveBeenCalledWith({
            widgetId: 'widget-1',
            title: '销售图表',
            description: '季度销售数据',
            html: '<div>设置</div>',
            phase: 'draft',
        });

        wrapper.unmount();
        expect(destroyMock).toHaveBeenCalled();
    });
});
