// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ModelWithProvider } from '@database/queries/models';
import type { ProviderDriver } from '@database/schema';

import { createProviderInstance, getModel } from './catalog';
import type { AiProvider } from './infrastructure/providers';

/**
 * Agent 子系统总入口。
 *
 * 整体分层设计：
 * - `contracts`：跨层共享的公共协议、工具事件、错误类型，是整个子系统的通用语言
 * - `catalog`：模型、provider、工具目录查询与实例化，只负责只读装配
 * - `prompt`：提示词片段、快照装配、传输消息构造，不直接执行模型请求
 * - `session`：会话历史、会话消息重组、会话级读取能力
 * - `task`：任务中心、任务快照、并发约束、前后台运行所有权
 * - `execution`：单个 task 内一次 turn/attempt 的执行、工具循环、checkpoint 与重试
 * - `outputs`：把运行事实输出到数据库、通知等外部系统
 * - `infrastructure`：provider 适配器、MCP、附件、设置读取等底层实现
 *
 */
/**
 * 对外暴露的 AI 服务 facade。
 *
 * 这里故意只保留“目录查询”和“provider 实例化”这类轻量入口。
 * 真正的会话执行统一走 `sessionTaskCenter`，避免页面或调用方绕过任务层直接控制运行时。
 */
export class AgentService {
    /**
     * 查询当前应使用的模型配置。
     */
    async getModel(options?: {
        providerId?: number;
        modelId?: string;
    }): Promise<ModelWithProvider> {
        return getModel(options);
    }

    /**
     * 创建一个可直接发请求的 provider 实例。
     */
    createProviderInstance(
        providerDriver: ProviderDriver,
        apiEndpoint: string,
        apiKey?: string | null,
        configJson?: string | null
    ): AiProvider {
        return createProviderInstance(providerDriver, apiEndpoint, apiKey, configJson);
    }
}

export type { ModelWithProvider };
export type {
    SessionTaskSnapshot,
    SessionTaskStatus,
    StartedSessionTask,
    StartSessionTaskOptions,
    TaskExecutionMode,
} from './task';
export { sessionTaskCenter } from './task';

// 导出单例
export const aiService = new AgentService();

// 导出错误类和错误码
export { AiError, AiErrorCode } from './contracts/errors';

// 导出会话管理函数
export { createSession, getSessionData, listSessions } from './session';
