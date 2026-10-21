// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import type { MessageKey } from '@/i18n';

/**
 * 模型能力开关 chip 的声明式定义，供 AddModelDialog 与 EditModelDialog 共用。
 *
 * 此前两个对话框各自在模板里把这段「标签键 + 颜色 + 条件 class」重复了 5 遍，
 * 共 10 处。颜色与顺序是视觉的一部分，集中定义后两个对话框不会漂移。
 */
export type CapabilityFormKey =
    | 'reasoning'
    | 'tool_call'
    | 'multimodal'
    | 'attachment'
    | 'open_weights';

export type CapabilityTone = 'blue' | 'green' | 'purple' | 'orange' | 'indigo';

export interface CapabilityChip {
    key: CapabilityFormKey;
    tone: CapabilityTone;
    labelKey: MessageKey;
}

export const CAPABILITY_CHIPS: ReadonlyArray<CapabilityChip> = [
    { key: 'reasoning', tone: 'blue', labelKey: 'model.capability.reasoning' },
    { key: 'tool_call', tone: 'green', labelKey: 'settings.mcp.tabs.tools' },
    { key: 'multimodal', tone: 'purple', labelKey: 'model.capability.multimodal' },
    { key: 'attachment', tone: 'orange', labelKey: 'model.capability.files' },
    { key: 'open_weights', tone: 'indigo', labelKey: 'model.capability.openWeights' },
];
