// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { SessionTaskUsageProgressEvent } from '@services/EventService';

/** 多路流的聚合视图 */
export interface LiveUsageAggregate {
    /** 仍在流式的路数 */
    activeCount: number;
    anyStreaming: boolean;
    /** 各活跃流瞬时速度之和；无可用样本时为 null */
    speed: number | null;
    /** 所有保留流的 token 合计 */
    totalTokens: number;
    /** 成本合计；任一路缺定价时为 null，避免混着缺失值求和 */
    totalCostMicros: number | null;
    /** 取最长的一路，代表这批任务已跑了多久 */
    elapsedMs: number;
    /** 最早出现过的首字延迟 */
    ttftMs: number | null;
    /** 去重后的模型名，按首次出现顺序 */
    modelNames: string[];
}

const EMPTY: LiveUsageAggregate = {
    activeCount: 0,
    anyStreaming: false,
    speed: null,
    totalTokens: 0,
    totalCostMicros: null,
    elapsedMs: 0,
    ttftMs: null,
    modelNames: [],
};

/**
 * 把多路流合并成一个可展示的快照。
 *
 * 速度只累加**仍在流式**的流：已结束的流速度应视为 0，
 * 否则它会把最后那个瞬时值一直算进合计，让曲线虚高。
 * token 与成本则累加全部保留的流，包括刚结束的，
 * 这样一轮跑完时数字不会突然回退。
 */
export function aggregateStreams(
    streams: readonly SessionTaskUsageProgressEvent[]
): LiveUsageAggregate {
    if (streams.length === 0) {
        return { ...EMPTY };
    }

    const active = streams.filter((stream) => stream.streaming);

    const speeds = active
        .map((stream) => stream.tokensPerSecond)
        .filter((speed): speed is number => speed !== null && Number.isFinite(speed));

    const costs = streams
        .map((stream) => stream.estimatedCostMicros)
        .filter((value): value is number => value !== null);

    const ttfts = streams
        .map((stream) => stream.ttftMs)
        .filter((value): value is number => value !== null);

    return {
        activeCount: active.length,
        anyStreaming: active.length > 0,
        speed: speeds.length > 0 ? speeds.reduce((sum, speed) => sum + speed, 0) : null,
        totalTokens: streams.reduce((sum, stream) => sum + stream.outputTokens, 0),
        // 部分流没定价时不给合计：缺失值当成 0 会低估
        totalCostMicros:
            costs.length === streams.length && costs.length > 0
                ? costs.reduce((sum, value) => sum + value, 0)
                : null,
        elapsedMs: streams.reduce((max, stream) => Math.max(max, stream.elapsedMs), 0),
        ttftMs: ttfts.length > 0 ? Math.min(...ttfts) : null,
        modelNames: [...new Set(streams.map((stream) => stream.modelName))],
    };
}

/**
 * 判断是否需要丢弃这批流。
 *
 * 新一轮开始时（有流在跑），已经结束的旧流不该再计入合计，
 * 否则上一轮的 token 会一直累加到这一轮上。
 *
 * @param isNewStream 到达的事件是否属于之前没见过的新流
 */
export function shouldDropFinishedStreams(
    streams: readonly SessionTaskUsageProgressEvent[],
    isNewStream: boolean
): boolean {
    if (!isNewStream) {
        return false;
    }

    const anyStreaming = streams.some((stream) => stream.streaming);
    const hasFinished = streams.some((stream) => !stream.streaming);
    return !anyStreaming && hasFinished;
}

/** 陈旧的已结束流是否该被清理（全部靠 linger 窗口决定） */
export function isStale(
    stream: SessionTaskUsageProgressEvent,
    seenAt: number,
    now: number,
    lingerMs: number
): boolean {
    if (stream.streaming) {
        return false;
    }
    return now - seenAt >= lingerMs;
}
