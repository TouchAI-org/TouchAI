// Copyright (c) 2026. 千诚. Licensed under GPL v3

/**
 * JSON 值类型（递归定义）
 */
export type JsonValue =
    | string
    | number
    | boolean
    | null
    | JsonValue[]
    | { [key: string]: JsonValue };

/**
 * JSON 对象类型
 */
export type JsonObject = { [key: string]: JsonValue };

/**
 * Cron 触发器
 */
export interface CronTrigger {
    type: 'cron';
    expression: string; // cron 表达式，例如 "0 9 * * *"
}

/**
 * 间隔触发器
 */
export interface IntervalTrigger {
    type: 'interval';
    milliseconds: number; // 间隔毫秒数
}

/**
 * 一次性触发器
 */
export interface OnceTrigger {
    type: 'once';
    timestamp: number; // 执行时间戳
}

/**
 * 事件触发器（扩展点）
 */
export interface EventTrigger {
    type: 'event';
    eventType: string; // 事件类型标识
    eventConfig?: JsonObject; // 事件特定配置
}

/**
 * 触发器联合类型
 */
export type ScheduleTrigger = CronTrigger | IntervalTrigger | OnceTrigger | EventTrigger;

/**
 * 定时任务
 */
export interface ScheduledTask {
    id: string;
    name: string;
    prompt: string;
    trigger: ScheduleTrigger;
    modelId?: string;
    providerId?: number;
    enabled: boolean;
    lastRunAt: number | null;
    nextRunAt: number | null;
    createdAt: number;
    updatedAt: number;
}

/**
 * 事件触发器处理器接口
 */
export interface EventTriggerHandler {
    eventType: string;
    displayName: string;
    description: string;
    configSchema?: JsonObject; // 配置参数的 JSON Schema
    setup: (config: JsonObject, callback: () => void) => Promise<() => void>;
}
