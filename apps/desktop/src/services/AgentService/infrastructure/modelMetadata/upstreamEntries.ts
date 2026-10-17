/*
 * Copyright (c) 2025-2026. Qian Cheng. Licensed under GPL v3
 */

import type { UpstreamModelMetadataEntry, UpstreamModelMetadataPatch } from '@database/types';

import { serializeReasoningOptions } from '../../contracts/reasoning';
import type { ModelCapabilities, ModelInfo } from '../providers/types';

/** 把上游声明的领域能力映射成 `models` 列形状；列名与 JSON 序列化只出现在这一层。 */
export function toUpstreamModelMetadataPatch(
    capabilities: ModelCapabilities
): UpstreamModelMetadataPatch | undefined {
    const patch: UpstreamModelMetadataPatch = {};

    if (capabilities.contextLimit !== undefined) {
        patch.context_limit = capabilities.contextLimit;
    }

    if (capabilities.outputLimit !== undefined) {
        patch.output_limit = capabilities.outputLimit;
    }

    if (capabilities.modalities) {
        patch.modalities = JSON.stringify(capabilities.modalities);
    }

    if (capabilities.attachment !== undefined) {
        patch.attachment = capabilities.attachment ? 1 : 0;
    }

    if (capabilities.reasoning !== undefined) {
        patch.reasoning = capabilities.reasoning ? 1 : 0;
    }

    const reasoningOptions = serializeReasoningOptions(capabilities.reasoningOptions);
    if (reasoningOptions) {
        patch.reasoning_options = reasoningOptions;
    }

    if (capabilities.toolCall !== undefined) {
        patch.tool_call = capabilities.toolCall ? 1 : 0;
    }

    return Object.keys(patch).length > 0 ? patch : undefined;
}

/** 把一次模型刷新拿到的上游声明转成 `upstream_metadata` 的写入载荷，未声明能力的模型直接跳过。 */
export function toUpstreamModelMetadataEntries(
    models: readonly ModelInfo[]
): UpstreamModelMetadataEntry[] {
    return models.flatMap((model) => {
        const metadata = model.capabilities
            ? toUpstreamModelMetadataPatch(model.capabilities)
            : undefined;

        return metadata ? [{ model_id: model.id, metadata }] : [];
    });
}
