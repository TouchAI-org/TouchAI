// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { AiToolDefinition } from '@/services/AiService/types';

import { z } from '../../../utils/toolSchema';

export const VISUALIZE_READ_ME_TOOL_NAME = 'builtin__visualize_read_me';
export const VISUALIZE_READ_ME_PARSE_TOOL_NAME = 'VisualizeReadMe';

export const SHOW_WIDGET_GUIDE_MODULES = [
    'CORE',
    'diagram',
    'mockup',
    'interactive',
    'chart',
    'art',
] as const;

export const SHOW_WIDGET_GUIDE_NAMES = SHOW_WIDGET_GUIDE_MODULES;

export type ShowWidgetGuideModule = (typeof SHOW_WIDGET_GUIDE_MODULES)[number];
export type ShowWidgetGuideName = ShowWidgetGuideModule;

export type ShowWidgetGuideSectionKey =
    | 'preamble'
    | 'modules'
    | 'core_design_system'
    | 'when_nothing_fits'
    | 'ui_components'
    | 'color_palette'
    | 'charts_chart_js'
    | 'svg_setup'
    | 'diagram_types'
    | 'art_and_illustration';
export type ShowWidgetGuideSectionTitle =
    | '_preamble'
    | 'Modules'
    | 'Core Design System'
    | 'When nothing fits'
    | 'UI components'
    | 'Color palette'
    | 'Charts (Chart.js)'
    | 'SVG setup'
    | 'Diagram types'
    | 'Art and illustration';

export interface SectionMappingFile {
    art: ShowWidgetGuideSectionTitle[];
    mockup: ShowWidgetGuideSectionTitle[];
    interactive: ShowWidgetGuideSectionTitle[];
    chart: ShowWidgetGuideSectionTitle[];
    diagram: ShowWidgetGuideSectionTitle[];
}

export const LEGACY_GUIDE_NAME_ALIASES = {
    'data-visualization': 'chart',
    mermaid: 'diagram',
} as const;

export const GUIDE_SECTION_KEY_BY_TITLE: Record<
    ShowWidgetGuideSectionTitle,
    ShowWidgetGuideSectionKey
> = {
    _preamble: 'preamble',
    Modules: 'modules',
    'Core Design System': 'core_design_system',
    'When nothing fits': 'when_nothing_fits',
    'UI components': 'ui_components',
    'Color palette': 'color_palette',
    'Charts (Chart.js)': 'charts_chart_js',
    'SVG setup': 'svg_setup',
    'Diagram types': 'diagram_types',
    'Art and illustration': 'art_and_illustration',
};
export const CORE_SECTION_KEYS = new Set<ShowWidgetGuideSectionKey>([
    'preamble',
    'modules',
    'core_design_system',
    'when_nothing_fits',
]);
export const CORE_SECTION_ORDER: readonly ShowWidgetGuideSectionKey[] = [
    'preamble',
    'modules',
    'core_design_system',
    'when_nothing_fits',
] as const;

export const showWidgetGuideSectionTitleSchema = z.enum([
    '_preamble',
    'Modules',
    'Core Design System',
    'When nothing fits',
    'UI components',
    'Color palette',
    'Charts (Chart.js)',
    'SVG setup',
    'Diagram types',
    'Art and illustration',
]);
export const sectionMappingFileSchema = z.object({
    art: z.array(showWidgetGuideSectionTitleSchema),
    mockup: z.array(showWidgetGuideSectionTitleSchema),
    interactive: z.array(showWidgetGuideSectionTitleSchema),
    chart: z.array(showWidgetGuideSectionTitleSchema),
    diagram: z.array(showWidgetGuideSectionTitleSchema),
});

export const visualizeReadMeArgsSchema = z
    .object({
        modules: z.array(z.string()).min(1).optional(),
        guideNames: z.array(z.string()).min(1).optional(),
    })
    .superRefine((value, context) => {
        if (!value.modules && !value.guideNames) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['modules'],
                message: 'Expected a non-empty modules array.',
            });
        }
    })
    .transform((value): { modules: string[] } => ({
        modules: value.modules ?? value.guideNames ?? [],
    }));

/**
 * 暴露给模型的 VisualizeReadMe 工具说明。
 */
export const VISUALIZE_READ_ME_TOOL_DESCRIPTION =
    "Before using show_widget, you must use this tool to read the appropriate guidelines. Read ['diagram'] for diagrams/flowcharts/org charts. Read ['mockup'] for UI component mockups. Read ['interactive'] for interactive widgets. Read ['chart'] for charts and data visualization. Read ['art'] for visual illustrations. Feel free to read multiple guidelines if needed. CORE is always included automatically.";

/**
 * 暴露给模型的 VisualizeReadMe 工具输入 schema。
 */
export const VISUALIZE_READ_ME_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {
        modules: {
            type: 'array',
            description: 'One or more guideline modules to load before calling show_widget.',
            items: {
                type: 'string',
                enum: SHOW_WIDGET_GUIDE_MODULES.filter(
                    (module) => module !== 'CORE'
                ) as unknown as string[],
            },
            minItems: 1,
        },
    },
    required: ['modules'],
    additionalProperties: false,
};
