// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { native } from '@services/NativeService';

import type { UsageFilter } from './usageStats';

export interface ContextShare {
    key: string;
    tokens: number;
    share: number;
}

export interface ContextScorePart {
    key: 'cache' | 'lean' | 'pace' | 'reliable';
    points: number;
    most: number;
}

export interface ContextTag {
    key: string;
    tone: 'good' | 'warn' | 'info';
}

export interface ContextProfile {
    modelId: number | null;
    modelName: string;
    window: number;
    turnCount: number;
    promptMedian: number;
    promptP90: number;
    baselineMedian: number;
    growthMedian: number;
    peakFill: number;
    cacheReuseRate: number;
    compactCount: number;
    errorRate: number;
    shares: ContextShare[];
    score: number;
    scores: ContextScorePart[];
    tags: ContextTag[];
}

export interface ContextTurnPoint {
    turnId: number;
    createdAt: string;
    modelId: number;
    promptTokens: number;
    window: number;
    fillRate: number;
    cacheReadTokens: number;
    isCompaction: boolean;
}

export const getContextProfiles = (
    filter: UsageFilter
): Promise<{ overall: ContextProfile | null; models: ContextProfile[] }> =>
    native.database.operation({ kind: 'usage_context_profiles', filter });

export const getContextTurnPoints = (
    filter: UsageFilter,
    limit = 200
): Promise<ContextTurnPoint[]> =>
    native.database.operation({ kind: 'usage_context_points', filter, limit });
