import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import type { ShowWidgetEventPayload } from '@/services/AgentService/contracts/tooling';
import { showWidgetTool } from '@/services/BuiltInToolService/tools/widgetTool/showWidget';
import { buildShowWidgetSummary } from '@/services/BuiltInToolService/tools/widgetTool/showWidget/helper';
import { buildShowWidgetDraftFromArgumentsBuffer } from '@/services/BuiltInToolService/tools/widgetTool/showWidget/runtime';
import { visualizeReadMeTool } from '@/services/BuiltInToolService/tools/widgetTool/visualizeReadMe';
import { readShowWidgetGuidelines } from '@/services/BuiltInToolService/tools/widgetTool/visualizeReadMe/guidelines';
import { buildGuidelineResult } from '@/services/BuiltInToolService/tools/widgetTool/visualizeReadMe/helper';

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

function collectSchemaDescriptions(value: unknown): string[] {
    if (!value || typeof value !== 'object') {
        return [];
    }

    const record = value as Record<string, unknown>;
    const descriptions = typeof record.description === 'string' ? [record.description] : [];

    return [
        ...descriptions,
        ...Object.values(record).flatMap((child) => collectSchemaDescriptions(child)),
    ];
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

    it('does not instruct Chart.js widgets to rely on stripped onload attributes', () => {
        const guidelines = readShowWidgetGuidelines(['chart']);

        expect(guidelines.markdown).toContain('Chart.js');
        expect(guidelines.markdown).not.toContain('onload=');
    });

    it('tells the model to call show_widget instead of answering with plain text after loading guidelines', () => {
        const result = buildGuidelineResult(readShowWidgetGuidelines(['diagram']));

        expect(result).toContain(
            'Do not answer the user with plain text after reading this guide.'
        );
        expect(result).toContain(
            'Your next assistant step must be a builtin__show_widget tool call'
        );
    });

    it('uses namespaced widget tool names in model-facing tool instructions', () => {
        const modelFacingDescriptions = [
            showWidgetTool.description,
            visualizeReadMeTool.description,
            ...collectSchemaDescriptions(showWidgetTool.inputSchema),
            ...collectSchemaDescriptions(visualizeReadMeTool.inputSchema),
        ].join('\n');
        const withoutNamespacedNames = modelFacingDescriptions
            .replace(/builtin__show_widget/g, '')
            .replace(/builtin__visualize_read_me/g, '');

        expect(modelFacingDescriptions).toContain('builtin__show_widget');
        expect(modelFacingDescriptions).toContain('builtin__visualize_read_me');
        expect(withoutNamespacedNames).not.toMatch(/\b(?:show_widget|visualize_read_me)\b/);
    });

    it('does not leak bare widget tool names in returned guideline text', () => {
        const result = buildGuidelineResult(
            readShowWidgetGuidelines(['diagram', 'interactive', 'chart'])
        );
        const withoutNamespacedNames = result
            .replace(/builtin__show_widget/g, '')
            .replace(/builtin__visualize_read_me/g, '');

        expect(withoutNamespacedNames).not.toMatch(/\b(?:show_widget|visualize_read_me|read_me)\b/);
    });

    it('does not include guideline examples that contradict flat visual rules', () => {
        const result = buildGuidelineResult(
            readShowWidgetGuidelines(['diagram', 'interactive', 'art'])
        );

        expect(result).not.toMatch(/one gradient per diagram is permitted/i);
        expect(result).not.toMatch(/<linearGradient\s+(?:id|gradientUnits|x1|x2|y1|y2)=/i);
        expect(result).not.toMatch(/fill=["']url\(#/i);
        expect(result).not.toMatch(/warm-glow|gradient-filled|physical-realism/i);
        expect(result).not.toMatch(/glows amber|glowing warm/i);
    });

    it('does not tell the model to delay the visible root element behind leading CSS', () => {
        const result = buildGuidelineResult(readShowWidgetGuidelines(['interactive']));
        const modelFacingDescriptions = [
            showWidgetTool.description,
            ...collectSchemaDescriptions(showWidgetTool.inputSchema),
            result,
        ].join('\n');

        expect(modelFacingDescriptions).not.toMatch(/CSS first/i);
        expect(modelFacingDescriptions).not.toMatch(/<style>[^→\n]*→\s*content HTML/i);
        expect(modelFacingDescriptions).not.toMatch(
            /optional <style>[^.]*visible HTML\/SVG structure/i
        );
        expect(modelFacingDescriptions).not.toMatch(/```html\s*<style\b/i);
        expect(modelFacingDescriptions).not.toMatch(/```html\s*<script\b/i);
    });

    it('does not mention legacy artifact tool names that TouchAI does not expose', () => {
        const result = buildGuidelineResult(
            readShowWidgetGuidelines(['diagram', 'interactive', 'mockup', 'art'])
        );

        expect(result).not.toContain('imagine_svg');
        expect(result).not.toContain('imagine_html');
        expect(result).not.toMatch(/\bClaude\b|claude\.ai/i);
    });

    it('does not recommend custom UI tags that the widget runtime does not implement', () => {
        const result = buildGuidelineResult(readShowWidgetGuidelines(['interactive', 'mockup']));

        expect(result).not.toMatch(/<\/?ui-(?:card|badge|button|input)\b/i);
        expect(result).not.toMatch(/`ui-(?:card|badge|button|input)`/i);
        expect(result).not.toMatch(/TouchAI widget components/i);
        expect(result).not.toMatch(/host app'?s component layer/i);
    });

    it('does not recommend sanitizer-stripped inline event attributes for interactions', () => {
        const result = buildGuidelineResult(
            readShowWidgetGuidelines(['diagram', 'interactive', 'mockup', 'chart'])
        );

        expect(result).not.toMatch(/\son(?:click|input|change|load)\s*=/i);
        expect(result).not.toMatch(/\bsendPrompt\b(?!-)/);
        expect(result).not.toContain('sendPrompt()/openLink()');
        expect(result).toContain('data-send-prompt');
        expect(result).toContain('addEventListener');
    });

    it('keeps Mermaid ERD guidance compatible with classic inline widget scripts', () => {
        const result = buildGuidelineResult(readShowWidgetGuidelines(['diagram']));

        expect(result).not.toContain('<script type="module">');
        expect(result).not.toMatch(/import\s+mermaid\s+from/i);
        expect(result).not.toContain('https://esm.sh/mermaid');
        expect(result).toContain('window.mermaid');
        expect(result).toContain('fontFamily');
        expect(result).toContain('fontSize');
        expect(result).toContain("rect.setAttribute('rx', '8')");
        expect(result).toContain("p.setAttribute('stroke', 'none')");
    });
});
