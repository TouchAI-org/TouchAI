// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { TauriDatabase } from './schema';
import { SettingKey } from './schema';

/**
 * 默认设置
 */
const DEFAULT_SETTINGS = [
    { key: SettingKey.THEME, value: 'light' },
    { key: SettingKey.LANGUAGE, value: 'zh-CN' },
    { key: SettingKey.AUTO_START, value: 'false' },
    { key: SettingKey.MCP_MAX_ITERATIONS, value: '10' },
    { key: SettingKey.OUTPUT_SCROLL_BEHAVIOR, value: 'follow_output' },
];

const DEFAULT_BUILT_IN_TOOLS = [
    {
        tool_id: 'bash',
        display_name: 'Bash',
        description: '执行终端命令',
        enabled: 1,
        risk_level: 'high',
        config_json: JSON.stringify({
            approvalMode: 'high_risk',
            defaultWorkingDirectory: 'D:\\Project\\TouchAI',
            allowedWorkingDirectories: ['D:\\Project\\TouchAI'],
            timeoutMs: 15000,
            maxOutputChars: 12000,
        }),
    },
    {
        tool_id: 'file_search',
        display_name: 'FileSearch',
        description: '搜索本机文件',
        enabled: 1,
        risk_level: 'low',
        config_json: null,
    },
    {
        tool_id: 'setting',
        display_name: 'Setting',
        description: '读取和修改应用设置',
        enabled: 1,
        risk_level: 'medium',
        config_json: null,
    },
    {
        tool_id: 'web_fetch',
        display_name: 'WebFetch',
        description: '抓取网页并提取易读文本',
        enabled: 1,
        risk_level: 'low',
        config_json: null,
    },
    {
        tool_id: 'upgrade_model',
        display_name: 'UpgradeModel',
        description: '升级当前请求模型',
        enabled: 1,
        risk_level: 'medium',
        config_json: JSON.stringify({
            chain: [],
        }),
    },
    {
        tool_id: 'show_widget',
        display_name: 'ShowWidget',
        description: '在聊天中渲染内联可交互自定义可视化',
        enabled: 1,
        risk_level: 'low',
        config_json: null,
    },
    {
        tool_id: 'visualize_read_me',
        display_name: 'VisualizeReadMe',
        description: '读取 ShowWidget 生成规范',
        enabled: 1,
        risk_level: 'low',
        config_json: null,
    },
];

/**
 * 内置服务商
 */
const BUILTIN_PROVIDERS = [
    {
        name: 'OpenAI',
        type: 'openai',
        api_endpoint: 'https://api.openai.com',
        logo: 'openai.png',
        enabled: 1,
        is_builtin: 1,
    },
    {
        name: 'Anthropic',
        type: 'anthropic',
        api_endpoint: 'https://api.anthropic.com',
        logo: 'anthropic.png',
        enabled: 0,
        is_builtin: 1,
    },
    {
        name: 'DeepSeek',
        type: 'openai',
        api_endpoint: 'https://api.deepseek.com',
        logo: 'deepseek.png',
        enabled: 0,
        is_builtin: 1,
    },
    {
        name: '火山引擎',
        type: 'openai',
        api_endpoint: 'https://ark.cn-beijing.volces.com/api/v3',
        logo: 'volcengine.png',
        enabled: 0,
        is_builtin: 1,
    },
    {
        name: 'Gemini',
        type: 'openai',
        api_endpoint: 'https://generativelanguage.googleapis.com',
        logo: 'gemini.png',
        enabled: 0,
        is_builtin: 1,
    },
    {
        name: 'Grok',
        type: 'openai',
        api_endpoint: 'https://api.x.ai',
        logo: 'grok.png',
        enabled: 0,
        is_builtin: 1,
    },
    {
        name: '腾讯混元',
        type: 'openai',
        api_endpoint: 'https://api.hunyuan.cloud.tencent.com',
        logo: 'hunyuan.png',
        enabled: 0,
        is_builtin: 1,
    },
    {
        name: 'MiniMax',
        type: 'anthropic',
        api_endpoint: 'https://api.minimaxi.com/anthropic',
        logo: 'minimax.png',
        enabled: 0,
        is_builtin: 1,
    },
    {
        name: '月之暗面',
        type: 'openai',
        api_endpoint: 'https://api.moonshot.cn',
        logo: 'moonshot.png',
        enabled: 0,
        is_builtin: 1,
    },
    {
        name: '阿里云百炼',
        type: 'openai',
        api_endpoint: 'https://dashscope.aliyuncs.com/compatible-mode',
        logo: 'bailian.png',
        enabled: 0,
        is_builtin: 1,
    },
    {
        name: '智谱',
        type: 'openai',
        api_endpoint: 'https://open.bigmodel.cn/api/paas',
        logo: 'zhipu.png',
        enabled: 0,
        is_builtin: 1,
    },
];

/**
 * 种子数据：插入默认设置和内置服务商
 * 每次启动时运行，按 key/name 逐条检查，仅插入缺失项
 * 内置数据通过常量数组声明，种子逻辑只补齐缺失项
 */
export async function seed(tauriDb: TauriDatabase): Promise<void> {
    await tauriDb.execute(
        `INSERT OR IGNORE INTO touchai_meta (key, value) VALUES ('app_id', 'touchai')`
    );

    // 插入默认设置（按 key 去重）
    const existingSettings = await tauriDb.select<{ key: string }>('SELECT key FROM settings');
    const existingKeys = new Set(existingSettings.map((s) => s.key));

    for (const setting of DEFAULT_SETTINGS) {
        if (!existingKeys.has(setting.key)) {
            await tauriDb.execute('INSERT INTO settings (key, value) VALUES (?, ?)', [
                setting.key,
                setting.value,
            ]);
        }
    }

    // 插入内置服务商（按 name 去重，仅补齐缺失项）
    const existingProviders = await tauriDb.select<{ name: string }>('SELECT name FROM providers');
    const existingNames = new Set(existingProviders.map((p) => p.name));

    for (const provider of BUILTIN_PROVIDERS) {
        if (!existingNames.has(provider.name)) {
            await tauriDb.execute(
                `INSERT INTO providers (name, type, api_endpoint, logo, enabled, is_builtin)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    provider.name,
                    provider.type,
                    provider.api_endpoint,
                    provider.logo,
                    provider.enabled,
                    provider.is_builtin,
                ]
            );
        }
    }

    const existingBuiltInTools = await tauriDb.select<{ tool_id: string }>(
        'SELECT tool_id FROM built_in_tools'
    );
    const existingToolIds = new Set(existingBuiltInTools.map((tool) => tool.tool_id));

    for (const tool of DEFAULT_BUILT_IN_TOOLS) {
        if (!existingToolIds.has(tool.tool_id)) {
            await tauriDb.execute(
                `INSERT INTO built_in_tools (tool_id, display_name, description, enabled, risk_level, config_json)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    tool.tool_id,
                    tool.display_name,
                    tool.description,
                    tool.enabled,
                    tool.risk_level,
                    tool.config_json,
                ]
            );
        }
    }

    console.log('[seed] Seed data applied');
}
