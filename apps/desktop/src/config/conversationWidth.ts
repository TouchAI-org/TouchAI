// Copyright (c) 2026. 千诚. Licensed under GPL v3

export const CONVERSATION_WIDTH = {
    default: 880,
    min: 640,
    max: 2400,
    step: 20,
} as const;

export function normalizeConversationWidth(value: unknown): number {
    const width = typeof value === 'string' && value.trim() ? Number(value) : value;
    if (typeof width !== 'number' || !Number.isFinite(width)) return CONVERSATION_WIDTH.default;
    const { min, max, step } = CONVERSATION_WIDTH;
    return Math.min(max, Math.max(min, Math.round(width / step) * step));
}
