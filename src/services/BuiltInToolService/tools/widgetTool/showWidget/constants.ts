// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { AiToolDefinition } from '@/services/AiService/types';

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
        reason: 'Do not embed iframe/object content. Render inline DOM directly.',
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
    'Do not use fixed positioning, viewport-filling wrappers, page chrome, external assets, or network requests.',
    'If scripts are necessary, the static HTML must already look meaningful before scripts run.',
].join(' ');

export const SHOW_WIDGET_TOOL_NAME = 'ShowWidget';
export const showWidgetRawArgsSchema = z.object({
    i_have_seen_read_me: z.boolean().optional(),
    iHaveSeenReadMe: z.boolean().optional(),
    widget_code: optionalTrimmedStringSchema,
    html: optionalTrimmedStringSchema,
    mode: z.enum(['render', 'remove']).optional(),
    widgetId: optionalTrimmedStringSchema,
    title: optionalTrimmedStringSchema,
    description: optionalTrimmedStringSchema,
});

/**
 * 暴露给模型的 ShowWidget 工具说明。
 */
export const SHOW_WIDGET_TOOL_DESCRIPTION = `CRITICAL STREAMING INSTRUCTION: Start widget_code IMMEDIATELY after the required boolean. The first characters of widget_code must already contain a visible root element (<svg>, <div>, <section>). Output visible structure first, metadata fields last. Use this tool to create live inline visual artifacts. TouchAI renders widgets as native DOM (not iframe) that streams progressively token-by-token. Before using this tool, call visualize_read_me with relevant modules (['diagram'], ['chart'], ['interactive'], ['mockup'], ['art']) and pass i_have_seen_read_me=true in the next round. Structure: CSS first (brief), visible HTML/SVG immediately, scripts last. Outputs using gradients, shadows, blur, glass effects, full-page HTML, iframe/object, or non-allowlisted external resources will be rejected. ${SHOW_WIDGET_STYLE_GUIDELINES}`;

function withExamples(description: string, ...examples: string[]): string {
    return `${description} Examples: ${examples.join(' | ')}.`;
}

/**
 * 暴露给模型的 ShowWidget 工具输入 schema。
 */
export const SHOW_WIDGET_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {
        i_have_seen_read_me: {
            type: 'boolean',
            description:
                'Set this to true only after you have called visualize_read_me and carefully read the returned guideline.',
        },
        widget_code: {
            type: 'string',
            description: withExamples(
                'STREAMING CRITICAL: Start this parameter FIRST. The opening characters must already be a visible root element (<svg viewBox="...", <div>, <section>). Structure: optional <style> (under 15 lines) -> visible HTML/SVG structure -> optional <script> last. The widget streams token-by-token, so emit structure early. Self-contained HTML, CSS, and JavaScript. Transparent background by default. No outer card shell, gradient, shadow, blur, or rounded wrapper unless explicitly a mockup. Feel like a natural conversation extension.',
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
    },
    required: ['i_have_seen_read_me', 'widget_code'],
    additionalProperties: false,
};
