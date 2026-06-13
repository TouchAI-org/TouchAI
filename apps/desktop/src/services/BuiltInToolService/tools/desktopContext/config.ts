// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { parseToolConfigJson, z } from '../../utils/toolSchema';

/**
 * `get_desktop_context` 工具的配置结构。
 *
 * 这些开关既控制前端是否默认注入选中文本摘要，
 * 也通过 capture flags 下发到原生层，决定后台 enrich 跑哪些子捕获。
 */
export interface DesktopContextToolConfig {
    /** 是否在后台 enrich 阶段捕获选中文本（关闭则连摘要都不捕获）。 */
    captureSelectedText: boolean;
    /** 是否把脱敏后的选中文本摘要默认注入 prompt。 */
    autoInjectSelectedText: boolean;
    /** 是否在 active window 为浏览器时捕获 URL/标题。 */
    captureBrowserUrl: boolean;
    /** 是否允许对已批准的截图做 OCR 文本识别。 */
    enableScreenshotOcr: boolean;
}

export const DEFAULT_DESKTOP_CONTEXT_TOOL_CONFIG: DesktopContextToolConfig = {
    captureSelectedText: true,
    autoInjectSelectedText: true,
    captureBrowserUrl: true,
    enableScreenshotOcr: false,
};

const desktopContextToolConfigSchema = z
    .object({
        captureSelectedText: z.boolean().optional().catch(undefined),
        autoInjectSelectedText: z.boolean().optional().catch(undefined),
        captureBrowserUrl: z.boolean().optional().catch(undefined),
        enableScreenshotOcr: z.boolean().optional().catch(undefined),
    })
    .transform(
        (value): DesktopContextToolConfig => ({
            captureSelectedText:
                value.captureSelectedText ??
                DEFAULT_DESKTOP_CONTEXT_TOOL_CONFIG.captureSelectedText,
            autoInjectSelectedText:
                value.autoInjectSelectedText ??
                DEFAULT_DESKTOP_CONTEXT_TOOL_CONFIG.autoInjectSelectedText,
            captureBrowserUrl:
                value.captureBrowserUrl ?? DEFAULT_DESKTOP_CONTEXT_TOOL_CONFIG.captureBrowserUrl,
            enableScreenshotOcr:
                value.enableScreenshotOcr ??
                DEFAULT_DESKTOP_CONTEXT_TOOL_CONFIG.enableScreenshotOcr,
        })
    );

export function parseDesktopContextToolConfig(
    configJson: string | null
): DesktopContextToolConfig {
    return parseToolConfigJson(
        desktopContextToolConfigSchema,
        configJson,
        DEFAULT_DESKTOP_CONTEXT_TOOL_CONFIG
    );
}

export function serializeDesktopContextToolConfig(config: DesktopContextToolConfig): string {
    return JSON.stringify(config);
}
