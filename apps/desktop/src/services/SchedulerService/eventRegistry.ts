// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { EventTrigger, EventTriggerHandler } from './types';

/**
 * 事件触发器注册表
 *
 * 管理所有已注册的事件触发器处理器，提供注册、查询和设置接口
 */
class EventTriggerRegistry {
    private handlers = new Map<string, EventTriggerHandler>();

    /**
     * 注册事件触发器处理器
     */
    register(handler: EventTriggerHandler): void {
        if (this.handlers.has(handler.eventType)) {
            console.warn(`[EventTriggerRegistry] Overwriting handler for ${handler.eventType}`);
        }
        this.handlers.set(handler.eventType, handler);
    }

    /**
     * 获取所有已注册的事件类型
     */
    getRegisteredEventTypes(): EventTriggerHandler[] {
        return Array.from(this.handlers.values());
    }

    /**
     * 获取指定事件类型的处理器
     */
    getHandler(eventType: string): EventTriggerHandler | undefined {
        return this.handlers.get(eventType);
    }

    /**
     * 设置事件触发器
     * @returns 清理函数
     */
    async setupEventTrigger(trigger: EventTrigger, callback: () => void): Promise<() => void> {
        const handler = this.handlers.get(trigger.eventType);

        if (!handler) {
            throw new Error(`Unknown event type: ${trigger.eventType}`);
        }

        return handler.setup(trigger.eventConfig ?? {}, callback);
    }
}

export const eventTriggerRegistry = new EventTriggerRegistry();
