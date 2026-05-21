// Copyright (c) 2026. 千诚. Licensed under GPL v3

import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
    type BuiltInToolConversationSemantic,
    type BuiltInToolExecutionResult,
} from '../../../types';
import {
    VISUALIZE_READ_ME_TOOL_DESCRIPTION,
    VISUALIZE_READ_ME_TOOL_INPUT_SCHEMA,
} from './constants';
import { readShowWidgetGuidelines } from './guidelines';
import { buildGuidelineResult, parseVisualizeReadMeArgs } from './helper';

export {
    SHOW_WIDGET_GUIDE_MODULES,
    SHOW_WIDGET_GUIDE_NAMES,
    type ShowWidgetGuideModule,
    type ShowWidgetGuideName,
    VISUALIZE_READ_ME_TOOL_NAME,
} from './constants';
export { readShowWidgetGuidelines } from './guidelines';

/**
 * 执行 visualize_read_me 工具，读取并返回 show_widget 规范。
 * @param args 工具参数。
 * @param config 当前工具配置。
 * @param context 当前执行上下文。
 * @returns 已拼装的规范文本结果。
 */
export async function executeVisualizeReadMeTool(
    args: Record<string, unknown>,
    config: Record<string, never>,
    context: BaseBuiltInToolExecutionContext
): Promise<BuiltInToolExecutionResult> {
    void config;
    void context.signal;

    const parsed = parseVisualizeReadMeArgs(args);
    const loaded = readShowWidgetGuidelines(parsed.modules);

    return {
        result: buildGuidelineResult(loaded),
        isError: false,
        status: 'success',
    };
}

/**
 * VisualizeReadMe 工具。
 *
 * 该工具在同一 widget 工具组内专门负责把规范注入模型上下文，
 * showWidget 本体只负责校验和渲染，不再重复承担规范装载职责。
 */
class VisualizeReadMeTool extends BuiltInTool<Record<string, never>> {
    readonly id = 'visualize_read_me' as const;
    readonly displayName = 'VisualizeReadMe';
    readonly description = VISUALIZE_READ_ME_TOOL_DESCRIPTION;
    readonly inputSchema = VISUALIZE_READ_ME_TOOL_INPUT_SCHEMA;
    readonly defaultConfig = {};

    override buildConversationSemantic(args: Record<string, unknown>) {
        void args;
        const semantic: BuiltInToolConversationSemantic = {
            action: 'review',
            target: '可视化规范',
        };
        return semantic;
    }

    override execute(
        args: Record<string, unknown>,
        config: Record<string, never>,
        context: BaseBuiltInToolExecutionContext
    ) {
        return executeVisualizeReadMeTool(args, config, context);
    }
}

export const visualizeReadMeTool = new VisualizeReadMeTool();
