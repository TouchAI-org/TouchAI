INSERT OR IGNORE INTO touchai_meta (key, value)
VALUES ('app_id', 'touchai');

INSERT INTO providers (
    name, driver, api_endpoint, api_key, config_json, logo, enabled, is_builtin
)
SELECT 'OpenAI', 'openai', 'https://api.openai.com', NULL, NULL, 'openai.png', 0, 1
WHERE NOT EXISTS (SELECT 1 FROM providers WHERE name = 'OpenAI');

INSERT INTO providers (
    name, driver, api_endpoint, api_key, config_json, logo, enabled, is_builtin
)
SELECT 'Anthropic', 'anthropic', 'https://api.anthropic.com', NULL, NULL, 'anthropic.png', 0, 1
WHERE NOT EXISTS (SELECT 1 FROM providers WHERE name = 'Anthropic');

INSERT INTO providers (
    name, driver, api_endpoint, api_key, config_json, logo, enabled, is_builtin
)
SELECT 'DeepSeek', 'deepseek', 'https://api.deepseek.com', NULL, NULL, 'deepseek.png', 0, 1
WHERE NOT EXISTS (SELECT 1 FROM providers WHERE name = 'DeepSeek');

INSERT INTO providers (
    name, driver, api_endpoint, api_key, config_json, logo, enabled, is_builtin
)
SELECT 'Xiaomi MiMo', 'mimo', 'https://token-plan-cn.xiaomimimo.com/v1', NULL, NULL, 'mimo.png', 0, 1
WHERE NOT EXISTS (SELECT 1 FROM providers WHERE name = 'Xiaomi MiMo');

INSERT INTO providers (
    name, driver, api_endpoint, api_key, config_json, logo, enabled, is_builtin
)
SELECT '火山引擎', 'openai', 'https://ark.cn-beijing.volces.com/api/v3', NULL, NULL, 'volcengine.png', 0, 1
WHERE NOT EXISTS (SELECT 1 FROM providers WHERE name = '火山引擎');

INSERT INTO providers (
    name, driver, api_endpoint, api_key, config_json, logo, enabled, is_builtin
)
SELECT 'Gemini', 'google', 'https://generativelanguage.googleapis.com', NULL, NULL, 'gemini.png', 0, 1
WHERE NOT EXISTS (SELECT 1 FROM providers WHERE name = 'Gemini');

INSERT INTO providers (
    name, driver, api_endpoint, api_key, config_json, logo, enabled, is_builtin
)
SELECT 'Grok', 'xai', 'https://api.x.ai/v1', NULL, NULL, 'grok.png', 0, 1
WHERE NOT EXISTS (SELECT 1 FROM providers WHERE name = 'Grok');

INSERT INTO providers (
    name, driver, api_endpoint, api_key, config_json, logo, enabled, is_builtin
)
SELECT '腾讯混元', 'openai', 'https://api.hunyuan.cloud.tencent.com/v1', NULL, NULL, 'hunyuan.png', 0, 1
WHERE NOT EXISTS (SELECT 1 FROM providers WHERE name = '腾讯混元');

INSERT INTO providers (
    name, driver, api_endpoint, api_key, config_json, logo, enabled, is_builtin
)
SELECT 'MiniMax', 'minimax', 'https://api.minimax.io/anthropic/v1', NULL, NULL, 'minimax.png', 0, 1
WHERE NOT EXISTS (SELECT 1 FROM providers WHERE name = 'MiniMax');

INSERT INTO providers (
    name, driver, api_endpoint, api_key, config_json, logo, enabled, is_builtin
)
SELECT '月之暗面', 'moonshot', 'https://api.moonshot.ai/v1', NULL, NULL, 'moonshot.png', 0, 1
WHERE NOT EXISTS (SELECT 1 FROM providers WHERE name = '月之暗面');

INSERT INTO providers (
    name, driver, api_endpoint, api_key, config_json, logo, enabled, is_builtin
)
SELECT '阿里云百炼', 'alibaba', 'https://dashscope.aliyuncs.com/compatible-mode/v1', NULL, NULL, 'bailian.png', 0, 1
WHERE NOT EXISTS (SELECT 1 FROM providers WHERE name = '阿里云百炼');

INSERT INTO providers (
    name, driver, api_endpoint, api_key, config_json, logo, enabled, is_builtin
)
SELECT '智谱', 'zhipu', 'https://open.bigmodel.cn/api/paas/v4', NULL, NULL, 'zhipu.png', 0, 1
WHERE NOT EXISTS (SELECT 1 FROM providers WHERE name = '智谱');

UPDATE providers
SET
    name = 'Xiaomi MiMo',
    api_endpoint = COALESCE(NULLIF(json_extract(config_json, '$.touchAiCustom.apiEndpoint'), ''), 'https://token-plan-cn.xiaomimimo.com/v1'),
    api_key = CASE
        WHEN json_extract(config_json, '$.touchAiMode') = 'custom'
            THEN COALESCE(NULLIF(api_key, ''), NULLIF(json_extract(config_json, '$.touchAiCustom.apiKey'), ''))
        ELSE CASE WHEN api_key LIKE 'ta_live_%' THEN NULL ELSE api_key END
    END,
    config_json = NULLIF(json_remove(COALESCE(config_json, '{}'), '$.managedAuth', '$.touchAiMode', '$.touchAiCustom'), '{}'),
    logo = 'mimo.png',
    enabled = CASE
        WHEN json_extract(config_json, '$.touchAiMode') = 'custom' THEN enabled
        WHEN api_endpoint = 'https://hub.touch-ai.org/api/v1'
            OR json_extract(config_json, '$.touchAiMode') = 'managed'
            OR json_extract(config_json, '$.managedAuth') IS NOT NULL
            OR api_key LIKE 'ta_live_%'
            THEN 0
        ELSE enabled
    END,
    updated_at = CURRENT_TIMESTAMP
WHERE is_builtin = 1
  AND driver = 'mimo'
  AND (api_endpoint = 'https://hub.touch-ai.org/api/v1'
    OR json_extract(config_json, '$.touchAiMode') IS NOT NULL
    OR json_extract(config_json, '$.managedAuth') IS NOT NULL
    OR json_extract(config_json, '$.touchAiCustom') IS NOT NULL
    OR api_key LIKE 'ta_live_%');

INSERT INTO built_in_tools (
    tool_id, display_name, description, enabled, risk_level, config_json
)
SELECT
    'bash',
    'Bash',
    '执行终端命令',
    1,
    'high',
    '{"approvalMode":"high_risk","timeoutMs":15000,"maxOutputChars":12000}'
WHERE NOT EXISTS (SELECT 1 FROM built_in_tools WHERE tool_id = 'bash');

INSERT INTO built_in_tools (
    tool_id, display_name, description, enabled, risk_level, config_json
)
SELECT 'file_search', 'FileSearch', '搜索本机文件', 1, 'low', NULL
WHERE NOT EXISTS (SELECT 1 FROM built_in_tools WHERE tool_id = 'file_search');

INSERT INTO built_in_tools (
    tool_id, display_name, description, enabled, risk_level, config_json
)
SELECT 'read', 'Read', '读取本地文件或目录，支持图片与 PDF', 1, 'medium', NULL
WHERE NOT EXISTS (SELECT 1 FROM built_in_tools WHERE tool_id = 'read');

INSERT INTO built_in_tools (
    tool_id, display_name, description, enabled, risk_level, config_json
)
SELECT 'setting', 'Setting', '读取和修改应用设置', 1, 'medium', NULL
WHERE NOT EXISTS (SELECT 1 FROM built_in_tools WHERE tool_id = 'setting');

INSERT INTO built_in_tools (
    tool_id, display_name, description, enabled, risk_level, config_json
)
SELECT 'web_fetch', 'WebFetch', '抓取网页并提取易读文本', 1, 'low', NULL
WHERE NOT EXISTS (SELECT 1 FROM built_in_tools WHERE tool_id = 'web_fetch');

INSERT INTO built_in_tools (
    tool_id, display_name, description, enabled, risk_level, config_json
)
SELECT 'web_search', 'WebSearch', '搜索网页候选来源', 1, 'low', NULL
WHERE NOT EXISTS (SELECT 1 FROM built_in_tools WHERE tool_id = 'web_search');

INSERT INTO built_in_tools (
    tool_id, display_name, description, enabled, risk_level, config_json
)
SELECT 'upgrade_model', 'UpgradeModel', '升级当前请求模型', 1, 'medium', '{"chain":[]}'
WHERE NOT EXISTS (SELECT 1 FROM built_in_tools WHERE tool_id = 'upgrade_model');

INSERT INTO built_in_tools (
    tool_id, display_name, description, enabled, risk_level, config_json
)
SELECT 'show_widget', 'ShowWidget', '在聊天中渲染内联可交互自定义可视化', 1, 'low', NULL
WHERE NOT EXISTS (SELECT 1 FROM built_in_tools WHERE tool_id = 'show_widget');

INSERT INTO built_in_tools (
    tool_id, display_name, description, enabled, risk_level, config_json
)
SELECT 'visualize_read_me', 'VisualizeReadMe', '读取 ShowWidget 生成规范', 1, 'low', NULL
WHERE NOT EXISTS (SELECT 1 FROM built_in_tools WHERE tool_id = 'visualize_read_me');

INSERT INTO built_in_tools (
    tool_id, display_name, description, enabled, risk_level, config_json
)
SELECT 'ask_user_question', 'AskUserQuestion', '向用户提出结构化问题', 1, 'low', NULL
WHERE NOT EXISTS (SELECT 1 FROM built_in_tools WHERE tool_id = 'ask_user_question');

INSERT INTO built_in_tools (
    tool_id, display_name, description, enabled, risk_level, config_json
)
SELECT 'browser', 'Browser', 'Unified browser control for session, observation, screenshots, and interactions', 1, 'medium', NULL
WHERE NOT EXISTS (SELECT 1 FROM built_in_tools WHERE tool_id = 'browser');
