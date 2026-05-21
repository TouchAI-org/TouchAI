// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { parseJsonWithSchema } from '@/utils/zod';

import {
    CORE_SECTION_KEYS,
    CORE_SECTION_ORDER,
    GUIDE_SECTION_KEY_BY_TITLE,
    LEGACY_GUIDE_NAME_ALIASES,
    type SectionMappingFile,
    sectionMappingFileSchema,
    SHOW_WIDGET_GUIDE_MODULES,
    type ShowWidgetGuideModule,
    type ShowWidgetGuideSectionKey,
    type ShowWidgetGuideSectionTitle,
} from './constants';

interface ShowWidgetGuidelineReadResult {
    modules: ShowWidgetGuideModule[];
    markdown: string;
}

type NonCoreShowWidgetGuideModule = Exclude<ShowWidgetGuideModule, 'CORE'>;

const guidelineFiles = import.meta.glob<string>('../../../../../prompts/show-widget/*', {
    query: '?raw',
    import: 'default',
    eager: true,
});

const guideSectionContentMap = new Map<ShowWidgetGuideSectionKey, string>();

let sectionMapping: SectionMappingFile | null = null;
for (const [path, content] of Object.entries(guidelineFiles)) {
    const fileName = path.match(/\/([^/]+)\.(md|json)$/)?.[1];
    if (!fileName) {
        continue;
    }

    if (fileName === 'mapping') {
        sectionMapping = parseJsonWithSchema(
            sectionMappingFileSchema,
            content,
            'show_widget 指南映射文件不是合法 JSON。'
        );
        continue;
    }

    guideSectionContentMap.set(fileName as ShowWidgetGuideSectionKey, content.trim());
}

function normalizeGuideName(value: string): ShowWidgetGuideModule | null {
    if (value === 'CORE') {
        return 'CORE';
    }

    const normalizedValue = value.trim();
    if (!normalizedValue) {
        return null;
    }

    if (SHOW_WIDGET_GUIDE_MODULES.includes(normalizedValue as ShowWidgetGuideModule)) {
        return normalizedValue as ShowWidgetGuideModule;
    }

    return (
        LEGACY_GUIDE_NAME_ALIASES[normalizedValue as keyof typeof LEGACY_GUIDE_NAME_ALIASES] ?? null
    );
}

function readModuleSectionTitles(
    moduleName: NonCoreShowWidgetGuideModule
): readonly ShowWidgetGuideSectionTitle[] {
    const titles = sectionMapping?.[moduleName];
    if (!titles?.length) {
        throw new Error(`Missing show widget section mapping for module: ${moduleName}`);
    }

    return titles;
}

function readSectionMarkdown(sectionTitle: ShowWidgetGuideSectionTitle): string {
    const sectionKey = GUIDE_SECTION_KEY_BY_TITLE[sectionTitle];
    const sectionMarkdown = guideSectionContentMap.get(sectionKey);
    if (!sectionMarkdown) {
        throw new Error(`Missing bundled show widget guide section: ${sectionKey}`);
    }

    return sectionMarkdown;
}

/**
 * 按模块拼装 show_widget 规范正文。
 *
 * @param modules 模型请求加载的规范模块名。
 * @returns 已按固定顺序拼装好的规范文本。
 */
export function readShowWidgetGuidelines(
    modules: readonly string[]
): ShowWidgetGuidelineReadResult {
    if (modules.length === 0) {
        throw new Error('visualize_read_me requires at least one module name.');
    }

    const normalizedGuideNames = new Set<ShowWidgetGuideModule>(['CORE']);
    for (const moduleName of modules) {
        const normalized = normalizeGuideName(moduleName);
        if (!normalized) {
            throw new Error(
                `Unknown show widget module: ${moduleName}. Valid modules: ${SHOW_WIDGET_GUIDE_MODULES.join(', ')}.`
            );
        }
        normalizedGuideNames.add(normalized);
    }

    const orderedGuideNames = SHOW_WIDGET_GUIDE_MODULES.filter((guideName) =>
        normalizedGuideNames.has(guideName)
    );
    const seenSections = new Set<ShowWidgetGuideSectionKey>(CORE_SECTION_KEYS);
    const markdownParts = CORE_SECTION_ORDER.map((sectionKey) => {
        const sectionMarkdown = guideSectionContentMap.get(sectionKey);
        if (!sectionMarkdown) {
            throw new Error(`Missing bundled show widget guide section: ${sectionKey}`);
        }

        return sectionMarkdown;
    });

    for (const guideName of orderedGuideNames) {
        if (guideName === 'CORE') {
            continue;
        }

        for (const sectionTitle of readModuleSectionTitles(guideName)) {
            const sectionKey = GUIDE_SECTION_KEY_BY_TITLE[sectionTitle];
            if (seenSections.has(sectionKey)) {
                continue;
            }

            seenSections.add(sectionKey);
            markdownParts.push(readSectionMarkdown(sectionTitle));
        }
    }

    return {
        modules: orderedGuideNames,
        markdown: markdownParts.join('\n\n\n'),
    };
}
