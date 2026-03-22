// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { parseToolArguments } from '../../../utils/toolSchema';
import { VISUALIZE_READ_ME_PARSE_TOOL_NAME, visualizeReadMeArgsSchema } from './constants';
import { readShowWidgetGuidelines } from './guidelines';

export function buildGuidelineResult(loaded: ReturnType<typeof readShowWidgetGuidelines>): string {
    return [
        `Loaded show_widget modules: ${loaded.modules.join(', ')}`,
        'Read the guideline below, follow it when writing widget_code, and then call builtin__show_widget with i_have_seen_read_me=true in the next tool round.',
        'TouchAI adaptation: show_widget renders as live inline DOM inside the current conversation document instead of an iframe. CSS variables resolve against the current page, sendPrompt()/openLink() are available as global helpers, partial HTML is patched progressively, and scripts should stay last. Start the tool arguments by opening widget_code as early as possible, make the first characters of widget_code already contain a visible root element or SVG skeleton, and only then fill in detail or optional metadata. Avoid styling html/body/:root and keep external resources within cdnjs/jsdelivr/unpkg/esm.sh. TouchAI uses a serif body default for widget text, so treat var(--font-serif) as the normal body face and only switch away deliberately. Prefer compact inline artifacts and keep SVG viewBox height tight to content, but TouchAI no longer hard-clamps widget height at runtime. Use standard HTML, SVG, and light DOM scripting directly instead of custom widget component tags.',
        '',
        loaded.markdown,
    ].join('\n');
}

export function parseVisualizeReadMeArgs(args: Record<string, unknown>) {
    return parseToolArguments(VISUALIZE_READ_ME_PARSE_TOOL_NAME, visualizeReadMeArgsSchema, args);
}
