// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 用量统计页的文案（zh-CN）。
 *
 * 单独成文件是因为这一块有 80+ 个 key，塞进主 messages 会淹没其他设置项。
 */
export const usageMessagesZhCN = {
    'settings.nav.usage.label': '用量统计',
    'settings.nav.usage.description': 'Token、成本与调用审计',
    'settings.loading.usage': '正在加载用量统计...',

    'settings.usage.title': '用量统计',
    'settings.usage.subtitle': 'Token、成本与调用审计',
    'settings.usage.refresh': '刷新',
    'settings.usage.loadFailed': '用量数据加载失败，请稍后重试',

    // 时间范围
    'settings.usage.range.today': '今天',
    'settings.usage.range.24h': '近 24 小时',
    'settings.usage.range.7d': '近 7 天',
    'settings.usage.range.30d': '近 30 天',
    'settings.usage.range.all': '全部',
    'settings.usage.range.custom': '自定义',

    // 筛选
    'settings.usage.filter.search': '搜索模型或供应商',
    'settings.usage.filter.provider.all': '全部供应商',
    'settings.usage.filter.model.all': '全部模型',
    'settings.usage.status.all': '全部状态',
    'settings.usage.status.completed': '仅成功',
    'settings.usage.status.failed': '仅失败',
    'settings.usage.status.cancelled': '仅取消',
    'settings.usage.status.retried': '重试后成功',

    // 指标
    'settings.usage.metric.label': '用量指标',
    'settings.usage.metric.cost': '总成本',
    'settings.usage.metric.costNote': '按 models.dev 单价估算',
    'settings.usage.metric.requests': '总请求',
    'settings.usage.metric.requestsNote': '成功率 {rate}',
    'settings.usage.metric.realTokens': '真实消耗 Tokens',
    'settings.usage.metric.realTokensNote': '新鲜输入 + 输出 + 缓存读写',
    'settings.usage.metric.cacheHitRate': '缓存命中率',
    'settings.usage.metric.cacheHitRateNote': '命中 ÷ 可缓存输入',
    'settings.usage.metric.freshInput': '新增输入',
    'settings.usage.metric.output': '输出',
    'settings.usage.metric.cacheWrite': '缓存写入',
    'settings.usage.metric.cacheRead': '缓存命中',
    'settings.usage.metric.reasoning': '其中推理',
    'settings.usage.metric.reasoningNote': '已含在输出内',
    'settings.usage.metric.ttft': '平均首字',
    'settings.usage.metric.unpriced': '{count} 次调用未定价',
    'settings.usage.metric.more': '更多指标',
    'settings.usage.metric.less': '收起',

    // 趋势
    'settings.usage.trend.title': '使用趋势',
    'settings.usage.trend.empty': '这段时间没有用量',
    'settings.usage.trend.metric.tokens': 'Tokens',
    'settings.usage.trend.metric.requests': '请求',
    'settings.usage.trend.metric.cost': '成本',

    // 热力图
    'settings.usage.heatmap.title': '用量热力图',
    'settings.usage.heatmap.summary': '近一年活跃 {days} 天 · 共 {tokens} tokens',
    'settings.usage.heatmap.tooltip': '{day} · {requests} 次 · {tokens} tokens · {cost}',
    'settings.usage.heatmap.less': '少',
    'settings.usage.heatmap.more': '多',

    // 分组/排行
    'settings.usage.group.byModel': '按模型',
    'settings.usage.group.byProvider': '按供应商',
    'settings.usage.group.empty': '暂无数据',
    'settings.usage.group.requests': '{count} 次',
    'settings.usage.group.tokens': 'tokens',
    'settings.usage.group.ttft': '首字',

    // Tab
    'settings.usage.tab.overview': '概览',
    'settings.usage.tab.calls': '调用',
    'settings.usage.tab.models': '模型',
    'settings.usage.tab.providers': '供应商',

    // 调用明细
    'settings.usage.calls.empty': '这段时间没有调用记录',
    'settings.usage.calls.unpriced': '未定价',
    'settings.usage.calls.cacheRate': '缓存',
    'settings.usage.calls.page': '第 {from}–{to} 条，共 {total} 条',
    'settings.usage.calls.prev': '上一页',
    'settings.usage.calls.next': '下一页',

    // 调用详情
    'settings.usage.detail.freshInput': '新增输入',
    'settings.usage.detail.output': '输出',
    'settings.usage.detail.cacheRead': '缓存命中',
    'settings.usage.detail.cacheWrite': '缓存写入',
    'settings.usage.detail.reasoning': '其中推理',
    'settings.usage.detail.finishReason': '结束原因',
    'settings.usage.detail.session': '所属会话',
    'settings.usage.detail.error': '错误信息',

    // 空状态
    'settings.usage.empty.title': '还没有用量数据',
    'settings.usage.empty.body': '开始一次对话后，这里会显示 Token 与成本统计',

    // 打码
    'settings.usage.mask.label': '打码',
    'settings.usage.mask.tip': '隐藏供应商与模型名，便于截图分享',
    'settings.usage.mask.placeholder': '模型 {index}',
} as const;

/** 用量统计页的文案（en-US） */
export const usageMessagesEnUS = {
    'settings.nav.usage.label': 'Usage',
    'settings.nav.usage.description': 'Tokens, cost, and call audit',
    'settings.loading.usage': 'Loading usage statistics...',

    'settings.usage.title': 'Usage',
    'settings.usage.subtitle': 'Tokens, cost, and call audit',
    'settings.usage.refresh': 'Refresh',
    'settings.usage.loadFailed': 'Failed to load usage data. Try again later.',

    'settings.usage.range.today': 'Today',
    'settings.usage.range.24h': '24 hours',
    'settings.usage.range.7d': '7 days',
    'settings.usage.range.30d': '30 days',
    'settings.usage.range.all': 'All',
    'settings.usage.range.custom': 'Custom',

    'settings.usage.filter.search': 'Search models or providers',
    'settings.usage.filter.provider.all': 'All providers',
    'settings.usage.filter.model.all': 'All models',
    'settings.usage.status.all': 'All statuses',
    'settings.usage.status.completed': 'Succeeded only',
    'settings.usage.status.failed': 'Failed only',
    'settings.usage.status.cancelled': 'Cancelled only',
    'settings.usage.status.retried': 'Succeeded after retry',

    'settings.usage.metric.label': 'Usage metrics',
    'settings.usage.metric.cost': 'Total cost',
    'settings.usage.metric.costNote': 'Estimated at models.dev prices',
    'settings.usage.metric.requests': 'Requests',
    'settings.usage.metric.requestsNote': '{rate} succeeded',
    'settings.usage.metric.realTokens': 'Tokens processed',
    'settings.usage.metric.realTokensNote': 'Fresh input + output + cache',
    'settings.usage.metric.cacheHitRate': 'Cache hit rate',
    'settings.usage.metric.cacheHitRateNote': 'Hits ÷ cacheable input',
    'settings.usage.metric.freshInput': 'Fresh input',
    'settings.usage.metric.output': 'Output',
    'settings.usage.metric.cacheWrite': 'Cache write',
    'settings.usage.metric.cacheRead': 'Cache read',
    'settings.usage.metric.reasoning': 'Reasoning',
    'settings.usage.metric.reasoningNote': 'Included in output',
    'settings.usage.metric.ttft': 'Mean first token',
    'settings.usage.metric.unpriced': '{count} calls unpriced',
    'settings.usage.metric.more': 'More metrics',
    'settings.usage.metric.less': 'Collapse',

    'settings.usage.trend.title': 'Usage trend',
    'settings.usage.trend.empty': 'No usage in this range',
    'settings.usage.trend.metric.tokens': 'Tokens',
    'settings.usage.trend.metric.requests': 'Requests',
    'settings.usage.trend.metric.cost': 'Cost',

    'settings.usage.heatmap.title': 'Usage heatmap',
    'settings.usage.heatmap.summary': '{days} active days · {tokens} tokens in the past year',
    'settings.usage.heatmap.tooltip': '{day} · {requests} calls · {tokens} tokens · {cost}',
    'settings.usage.heatmap.less': 'Less',
    'settings.usage.heatmap.more': 'More',

    'settings.usage.group.byModel': 'By model',
    'settings.usage.group.byProvider': 'By provider',
    'settings.usage.group.empty': 'No data',
    'settings.usage.group.requests': '{count} calls',
    'settings.usage.group.tokens': 'tokens',
    'settings.usage.group.ttft': 'TTFT',

    'settings.usage.tab.overview': 'Overview',
    'settings.usage.tab.calls': 'Calls',
    'settings.usage.tab.models': 'Models',
    'settings.usage.tab.providers': 'Providers',

    'settings.usage.calls.empty': 'No calls in this range',
    'settings.usage.calls.unpriced': 'Unpriced',
    'settings.usage.calls.cacheRate': 'Cache',
    'settings.usage.calls.page': '{from}–{to} of {total}',
    'settings.usage.calls.prev': 'Previous',
    'settings.usage.calls.next': 'Next',

    'settings.usage.detail.freshInput': 'Fresh input',
    'settings.usage.detail.output': 'Output',
    'settings.usage.detail.cacheRead': 'Cache read',
    'settings.usage.detail.cacheWrite': 'Cache write',
    'settings.usage.detail.reasoning': 'Reasoning',
    'settings.usage.detail.finishReason': 'Finish reason',
    'settings.usage.detail.session': 'Session',
    'settings.usage.detail.error': 'Error',

    'settings.usage.empty.title': 'No usage data yet',
    'settings.usage.empty.body': 'Start a conversation and token and cost stats will appear here',

    'settings.usage.mask.label': 'Mask',
    'settings.usage.mask.tip': 'Hide provider and model names for screenshots',
    'settings.usage.mask.placeholder': 'Model {index}',
} as const;
