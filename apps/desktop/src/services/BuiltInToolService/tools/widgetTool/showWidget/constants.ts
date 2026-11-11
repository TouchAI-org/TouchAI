// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { AiToolDefinition } from '@/services/AgentService/contracts/tooling';

import { optionalTrimmedStringSchema, z } from '../../../utils/toolSchema';

export const MAX_WIDGET_HTML_CHARS = 120000;
export const SHOW_WIDGET_EXTERNAL_RESOURCE_SELECTOR = [
    'script[src]',
    'link[href]',
    'img[src]',
    'audio[src]',
    'video[src]',
    'source[src]',
    'track[src]',
    'iframe[src]',
    'embed[src]',
    'object[data]',
].join(', ');

export const FORBIDDEN_WIDGET_RULES = [
    {
        pattern: /(?:linear|radial|conic)-gradient\s*\(/i,
        reason: 'Do not use gradients.',
    },
    {
        pattern: /<(?:linearGradient|radialGradient|pattern|filter)\b/i,
        reason: 'Do not use SVG gradients, patterns, or filters.',
    },
    {
        pattern: /\sfilter\s*=\s*(?:(["'])(?!none\1)[^"']*\1|(?!["'])(?!none(?=[\s>/]))[^>\s]+)/i,
        reason: 'Do not use SVG filter attributes.',
    },
    {
        pattern: /box-shadow\s*:/i,
        reason: 'Do not use shadows.',
    },
    {
        pattern: /text-shadow\s*:/i,
        reason: 'Do not use text shadows.',
    },
    {
        pattern: /backdrop-filter\s*:/i,
        reason: 'Do not use backdrop blur or glass effects.',
    },
    {
        pattern: /filter\s*:\s*(?!none\b)/i,
        reason: 'Do not use CSS filter effects.',
    },
    {
        pattern: /<(?:html|body)\b/i,
        reason: 'Output a single rooted fragment instead of a full HTML page.',
    },
    {
        pattern: /<(?:iframe|embed|object)\b/i,
        reason: 'Do not embed iframe/object content inside the widget sandbox.',
    },
] as const;

export const SHOW_WIDGET_STYLE_GUIDELINES = [
    'The artifact should feel like a natural extension of the conversation instead of a separate card or mini app.',
    'Most artifacts should have a transparent background with no separate outer container border or fixed surface.',
    'Do not set background or background-color on the outer wrapper unless the artifact is explicitly a contained mockup interface the user asked for.',
    'Do not round the outer wrapper, do not create a generic card shell, and do not add decorative chrome.',
    'No gradients, no shadows, no blur, no glow, no glassmorphism, no backdrop-filter, and no loud brand styling.',
    'Keep every generated element visually contained inside the inline widget area.',
    'Keep widgets compact. Do not generate long article-like pages, giant canvases, or towering diagrams that require many screenfuls of vertical space.',
    'Inside widget_code, keep CSS brief, then emit visible HTML or SVG structure early, and put script blocks last.',
    'Stream visible structure first: SVG skeletons, rows, axes, labels, controls, placeholders, then progressively fill details.',
    'Prefer a single rooted HTML fragment with inline <style>; do not build a full-page layout.',
    'In SVG, do not use linearGradient/radialGradient, pattern, filter, or filter attributes; use flat fills, strokes, opacity, and shape repetition instead.',
    'Do not use fixed positioning, viewport-filling wrappers, page chrome, external assets, or network requests.',
    'If scripts are necessary, the static HTML must already look meaningful before scripts run.',
].join(' ');

export const SHOW_WIDGET_TOOL_NAME = 'ShowWidget';
export const showWidgetRawArgsSchema = z
    .object({
        is_read_widget_skill: z.literal(true),
        widget_code: optionalTrimmedStringSchema,
        html: optionalTrimmedStringSchema,
        mode: z.enum(['render', 'remove']).optional(),
        widgetId: optionalTrimmedStringSchema,
        title: z.string().trim().optional(),
        description: z.string().trim().optional(),
    })
    .strict();

/**
 * 暴露给模型的 ShowWidget 工具说明。
 */
export const SHOW_WIDGET_TOOL_DESCRIPTION = [
    'CRITICAL STREAMING INSTRUCTION: Pass is_read_widget_skill: true first, then start widget_code IMMEDIATELY.',
    'The first characters of widget_code must already contain a visible root element (<svg>, <div>, <section>).',
    'Output visible structure first, metadata fields last.',
    'Use this tool to create live inline visual artifacts.',
    'TouchAI streams widget DOM into an opaque-origin sandbox iframe, with controlled host theme variables, keyed DOM patching, and final classic scripts.',
    'This tool is exposed to the model as builtin__show_widget. Load the built-in widget skill with builtin__activate_skill using its exact catalog path under appRoot/skills/.system/widget/SKILL.md, then set is_read_widget_skill to true for every creation, update, or removal.',
    'Structure: visible root and visible HTML/SVG first, optional inline <style> inside that root after the first visible content, scripts last.',
    'Outputs using gradients, shadows, blur, glass effects, full-page HTML, iframe/object, or non-allowlisted external resources will be rejected.',
    SHOW_WIDGET_STYLE_GUIDELINES,
].join(' ');

function withExamples(description: string, ...examples: string[]): string {
    return `${description} Examples: ${examples.join(' | ')}.`;
}

/**
 * 暴露给模型的 ShowWidget 工具输入 schema。
 */
export const SHOW_WIDGET_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {
        is_read_widget_skill: {
            type: 'boolean',
            const: true,
            description:
                'Set to true after reading the built-in widget skill. This is a model reminder, not a credential. Pass it before widget_code.',
        },
        widget_code: {
            type: 'string',
            description: withExamples(
                'Required for render mode; omit for remove mode. STREAMING CRITICAL: Start this parameter immediately after is_read_widget_skill. The opening characters must already be a visible root element (<svg viewBox="...", <div>, <section>) with visible structure or labels immediately inside it. Use inline styles for controls that must look correct mid-stream, or place a short <style> inside the visible root after the first visible content. Put optional <script> last. The widget streams token-by-token, so emit structure early. Self-contained HTML, CSS, and JavaScript. Transparent background by default. No outer card shell, gradient, shadow, blur, or rounded wrapper unless explicitly a mockup. Feel like a natural conversation extension.',
                '"<svg viewBox=\\"0 0 320 140\\" role=\\"img\\" aria-label=\\"Weekly revenue trend\\"><path d=\\"...\\" /></svg>"',
                '"<section><style>.root{display:grid;gap:8px}.row{display:flex;justify-content:space-between;border-bottom:1px solid color-mix(in oklch, currentColor 18%, transparent)}</style><div class=\\"root\\">...</div></section>"'
            ),
        },
        mode: {
            type: 'string',
            enum: ['render', 'remove'],
            description: withExamples(
                'Optional lifecycle action. Use "render" to create or replace a widget. Use "remove" to delete an existing widget by id.',
                '"render"',
                '"remove"'
            ),
        },
        widgetId: {
            type: 'string',
            description: withExamples(
                'Stable widget id. Reuse the same id when updating the same inline artifact later in the same conversation. Required for remove mode.',
                '"sales-dashboard"',
                '"weather-7day"'
            ),
        },
        title: {
            type: 'string',
            description: 'Optional short title used as the widget accessible label.',
        },
        description: {
            type: 'string',
            description: 'Optional widget description used for presentation and accessibility.',
        },
    },
    required: ['is_read_widget_skill'],
    additionalProperties: false,
};
