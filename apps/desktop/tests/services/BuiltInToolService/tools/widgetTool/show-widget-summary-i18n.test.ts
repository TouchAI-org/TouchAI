import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import type { ShowWidgetEventPayload } from '@/services/AgentService/contracts/tooling';
import { showWidgetTool } from '@/services/BuiltInToolService/tools/widgetTool/showWidget';
import { buildShowWidgetSummary } from '@/services/BuiltInToolService/tools/widgetTool/showWidget/helper';
import { buildShowWidgetDraftFromArgumentsBuffer } from '@/services/BuiltInToolService/tools/widgetTool/showWidget/runtime';
import { visualizeReadMeTool } from '@/services/BuiltInToolService/tools/widgetTool/visualizeReadMe';

function createPayload(overrides: Partial<ShowWidgetEventPayload> = {}): ShowWidgetEventPayload {
    return {
        callId: 'call-1',
        widgetId: 'widget-1',
        title: '销售漏斗',
        description: '保留模型写入说明',
        html: '<div>content</div>',
        mode: 'render',
        phase: 'ready',
        ...overrides,
    };
}

describe('ShowWidget generated summaries i18n', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('localizes rendered summary labels in English mode while preserving model-provided fields', () => {
        setLocale('en-US');

        const result = buildShowWidgetSummary(createPayload());

        expect(result).toContain('Custom visualization rendered');
        expect(result).toContain('Title: 销售漏斗');
        expect(result).toContain('Description: 保留模型写入说明');
        expect(result).toContain('HTML characters: 18');
        expect(result).toContain(
            'Continue explaining the visualization naturally instead of repeating the HTML source.'
        );
        expect(result).not.toContain('自定义可视化已渲染');
        expect(result).not.toContain('说明:');
    });

    it('localizes removed summary labels in English mode', () => {
        setLocale('en-US');

        const result = buildShowWidgetSummary(
            createPayload({
                mode: 'remove',
            })
        );

        expect(result).toContain('Custom visualization removed');
        expect(result).toContain(
            'Full HTML was not written to the tool result to avoid polluting later context.'
        );
        expect(result).not.toContain('自定义可视化已移除');
    });

    it('localizes draft fallback title and description in English mode', () => {
        setLocale('en-US');

        const draft = buildShowWidgetDraftFromArgumentsBuffer('call-1', '{"widget_code":"<div>');

        expect(draft).toMatchObject({
            title: 'Generating visualization',
            description:
                'The model is streaming inline visualization content based on the loaded specification.',
        });
    });

    it('localizes visualize_read_me conversation summary target in English mode', () => {
        setLocale('en-US');

        expect(visualizeReadMeTool.buildConversationSemantic({})).toMatchObject({
            action: 'review',
            target: 'visualization specification',
        });
    });

    it('localizes show_widget fallback conversation summary target in English mode', () => {
        setLocale('en-US');

        expect(showWidgetTool.buildConversationSemantic({})).toMatchObject({
            action: 'render',
            target: 'Visualization',
        });
    });
});
