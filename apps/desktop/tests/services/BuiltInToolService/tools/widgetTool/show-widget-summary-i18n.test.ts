import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import type { ShowWidgetEventPayload } from '@/services/AgentService/contracts/tooling';
import { parseSkillMarkdown } from '@/services/AgentService/skills/parser';
import { showWidgetTool } from '@/services/BuiltInToolService/tools/widgetTool/showWidget';
import { buildShowWidgetSummary } from '@/services/BuiltInToolService/tools/widgetTool/showWidget/helper';
import { buildShowWidgetDraftFromArgumentsBuffer } from '@/services/BuiltInToolService/tools/widgetTool/showWidget/runtime';

function readWidgetSkill(): string {
    const root = resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../../../src/prompts/skills/widget'
    );
    return [
        'SKILL.md',
        'references/ui_components.md',
        'references/color_palette.md',
        'references/charts.md',
        'references/svg_setup.md',
        'references/diagram_overview.md',
        'references/diagram_flowchart.md',
        'references/diagram_structural.md',
        'references/diagram_illustrative.md',
        'references/art_and_illustration.md',
    ]
        .map((file) => readFileSync(resolve(root, file), 'utf8'))
        .join('\n');
}

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

describe('user reads widget summaries in their own language', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('user reads rendered summary labels in English while model-provided fields stay as written', () => {
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

    it('user reads removed summary labels in English', () => {
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

    it('user reads the draft fallback title and description in English', () => {
        setLocale('en-US');

        const draft = buildShowWidgetDraftFromArgumentsBuffer('call-1', '{"widget_code":"<div>');

        expect(draft).toMatchObject({
            title: 'Generating visualization',
            description:
                'The model is streaming inline visualization content based on the loaded specification.',
        });
    });

    it('user reads the widget summary fallback target in English', () => {
        setLocale('en-US');

        expect(showWidgetTool.buildConversationSemantic({})).toMatchObject({
            action: 'render',
            target: 'Visualization',
        });
    });

    it('user is not told to rely on stripped onload attributes in chart widgets', () => {
        const guidelines = readWidgetSkill();

        expect(guidelines).toContain('Chart.js');
        expect(guidelines).not.toContain('onload=');
    });

    it('user can load the complete widget guide as a standard built-in skill', () => {
        const result = readWidgetSkill();
        const parsed = parseSkillMarkdown(result, '/appRoot/skills/.system/widget/SKILL.md');

        expect(parsed.name).toBe('widget');
        expect(parsed.description).toBeTruthy();
        expect(parsed.shortDescription).toBeTruthy();
        expect(result).toContain('is_read_widget_skill: true');
        expect(result).not.toContain('skill_key');
        expect(result).toContain('builtin__activate_skill');
        expect(result).toContain('skills/.system/widget/SKILL.md');
        expect(result).not.toContain('builtin://');
        expect(result).not.toContain('i_have_seen_read_me');
        expect(result).not.toContain('visualize_read_me');
        expect(result).not.toContain(
            'Do not answer the user with plain text after reading this guide.'
        );
        expect(result).not.toContain(
            'Your next assistant step must be a builtin__show_widget tool call'
        );
        for (const section of [
            'Core Design System',
            'When nothing fits',
            'UI components',
            'Color palette',
            'Charts (Chart.js)',
            'SVG setup',
            'Diagram types',
            'Art and illustration',
        ]) {
            expect(result).toContain(`## ${section}`);
        }
    });

    it('user receives instructions matching the sandbox when loading the widget guide', () => {
        const result = readWidgetSkill();

        expect(result).toContain('opaque-origin sandbox iframe');
        expect(result).toContain('controlled theme');
        expect(result).toContain('data-widget-key');
        expect(result).toContain('classic');
        expect(result).not.toMatch(/native DOM \(not (?:an )?iframe\)|instead of an iframe/i);
    });

    it('user sees namespaced widget tool names in model-facing instructions', () => {
        const modelFacingDescriptions = [
            showWidgetTool.description,
            ...collectSchemaDescriptions(showWidgetTool.inputSchema),
        ].join('\n');
        const withoutNamespacedNames = modelFacingDescriptions
            .replace(/builtin__show_widget/g, '')
            .replace(/builtin__activate_skill/g, '');

        expect(modelFacingDescriptions).toContain('builtin__show_widget');
        expect(modelFacingDescriptions).toContain('builtin__activate_skill');
        expect(withoutNamespacedNames).not.toMatch(
            /\b(?:show_widget|activate_skill|visualize_read_me)\b/
        );
    });

    it('user does not see bare widget tool names leak into guideline text', () => {
        const result = readWidgetSkill();
        const withoutNamespacedNames = result
            .replace(/builtin__show_widget/g, '')
            .replace(/builtin__activate_skill/g, '');

        expect(withoutNamespacedNames).not.toMatch(/\b(?:show_widget|visualize_read_me|read_me)\b/);
    });

    it('user does not see guideline examples that contradict the flat visual rules', () => {
        const result = readWidgetSkill();

        expect(result).not.toMatch(/one gradient per diagram is permitted/i);
        expect(result).not.toMatch(/<linearGradient\s+(?:id|gradientUnits|x1|x2|y1|y2)=/i);
        expect(result).not.toMatch(/fill=["']url\(#/i);
        expect(result).not.toMatch(/warm-glow|gradient-filled|physical-realism/i);
        expect(result).not.toMatch(/glows amber|glowing warm/i);
    });

    it('user is not told to delay the visible root element behind leading CSS', () => {
        const result = readWidgetSkill();
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

    it('user does not see legacy artifact tool names that TouchAI does not expose', () => {
        const result = readWidgetSkill();

        expect(result).not.toContain('imagine_svg');
        expect(result).not.toContain('imagine_html');
        expect(result).not.toMatch(/\bClaude\b|claude\.ai/i);
    });

    it('user does not see custom UI tags recommended that the widget runtime does not implement', () => {
        const result = readWidgetSkill();

        expect(result).not.toMatch(/<\/?ui-(?:card|badge|button|input)\b/i);
        expect(result).not.toMatch(/`ui-(?:card|badge|button|input)`/i);
        expect(result).not.toMatch(/TouchAI widget components/i);
        expect(result).not.toMatch(/host app'?s component layer/i);
    });

    it('user does not see sanitizer-stripped inline event attributes recommended for interactions', () => {
        const result = readWidgetSkill();

        expect(result).not.toMatch(/\son(?:click|input|change|load)\s*=/i);
        expect(result).not.toMatch(/\bsendPrompt\b(?!-)/);
        expect(result).not.toContain('sendPrompt()/openLink()');
        expect(result).toContain('data-send-prompt');
        expect(result).toContain('addEventListener');
    });

    it('user sees Mermaid ERD guidance that works with classic inline widget scripts', () => {
        const result = readWidgetSkill();

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
