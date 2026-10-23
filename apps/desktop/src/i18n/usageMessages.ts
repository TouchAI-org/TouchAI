// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * Usage page copy (zh-CN).
 *
 * Kept in its own file because the block has dozens of keys that would
 * drown out the rest of the settings copy.
 */
export const usageMessagesZhCN = {
    'settings.nav.usage.label': '用量统计',
    'settings.nav.usage.description': 'Token、成本与调用审计',
    'settings.loading.usage': '正在加载用量统计...',

    // Retention lives under data management
    'settings.dataManagement.retention.title': '调用明细保留',
    'settings.dataManagement.retention.description':
        '按此策略清理历史调用明细；日汇总永久保留，「全部时间」趋势不受影响。',
    'settings.dataManagement.retention.label': '保留调用明细',
    'settings.dataManagement.retention.hint': '默认不删除任何数据，清理在下次启动时生效',
    'settings.dataManagement.retention.forever': '永久保留',
    'settings.dataManagement.retention.days': '{days} 天',
    'settings.dataManagement.retention.saved': '已保存，下次启动时生效',

    'settings.usage.loadFailed': '用量数据加载失败，请稍后重试',

    // Retention
    // Group table headers

    // Range
    'settings.usage.range.today': '今天',
    'settings.usage.range.24h': '近 24 小时',
    'settings.usage.range.7d': '近 7 天',
    'settings.usage.range.30d': '近 30 天',
    'settings.usage.range.all': '全部',
    'settings.usage.range.custom': '自定义',

    // Filters
    'settings.usage.filter.search': '搜索模型或供应商',
    'settings.usage.filter.provider.all': '全部供应商',
    'settings.usage.filter.model.all': '全部模型',
    'settings.usage.status.all': '全部状态',
    'settings.usage.status.completed': '仅成功',
    'settings.usage.status.failed': '仅失败',
    'settings.usage.status.cancelled': '仅取消',
    'settings.usage.status.retried': '重试后成功',

    // Metrics
    'settings.usage.metric.cost': '总成本',
    'settings.usage.metric.costNote': '基于官方价格估算',
    'settings.usage.metric.rpm': '平均 RPM',
    'settings.usage.metric.rpmUnit': '次/分',
    'settings.usage.metric.requests': '总请求',
    'settings.usage.metric.requestsNote': '成功率 {rate}',
    'settings.usage.metric.sessions': '会话数',
    'settings.usage.metric.sessionsNote': '产生过用量的会话',
    'settings.usage.metric.tokens': '消耗 Tokens',
    'settings.usage.metric.tokensNote': '含缓存读写',
    'settings.usage.metric.tokensNoteWithLive': '含缓存与本轮估算',
    'settings.usage.metric.freshInput': '新增输入',
    'settings.usage.metric.output': '输出',
    'settings.usage.metric.cacheRead': '缓存读取',
    'settings.usage.metric.cacheReadNote': '命中率 {rate}',
    'settings.usage.metric.cacheWrite': '缓存写入',
    'settings.usage.metric.activeDuration': '活跃时长',
    'settings.usage.metric.activeDay': '共 {count} 天',
    'settings.usage.metric.activeDays': '共 {count} 天',
    'settings.usage.metric.activeDurationNote':
        '所选区间内各回合耗时之和；并行回合分别累加，天数按本地日期去重',
    'settings.usage.duration.hour': '小时',
    'settings.usage.duration.minute': '分',
    'settings.usage.duration.second': '秒',
    'settings.usage.metric.reasoning': '其中推理',
    'settings.usage.metric.ttft': '平均首字',
    'settings.usage.metric.ttftNote': '首 token 延迟',
    'settings.usage.metric.firstText': '首字耗时',
    'settings.usage.metric.firstTextNote': '首个正文出现，不含推理',
    'settings.usage.metric.unpriced': '{count} 次调用未定价',

    // Trend
    'settings.usage.trend.empty': '这段时间没有用量',
    'settings.usage.trend.metric.tokens': 'Tokens',
    'settings.usage.trend.metric.requests': '请求',
    'settings.usage.trend.metric.cost': '成本',

    // Trend chart with distribution
    'settings.usage.chart.title': '使用趋势与分布',
    'settings.usage.chart.other': '其他',
    'settings.usage.chart.total': '合计',

    // Live panel
    'settings.usage.live.activeSessions': '{count} 个会话',

    // Dashboard
    'settings.usage.dashboardCurveTitle': '消耗 Token',
    'settings.usage.curve.liveWindow': '最近 15 秒',
    'settings.usage.curve.liveSpeed': '实时速度',
    'settings.usage.curve.avgSpeed': '平均速度',
    'settings.usage.curve.sessionCount': '{count} 个会话',

    // Rankings
    'settings.usage.ranking.modelTitle': '模型排行',
    'settings.usage.ranking.sessionTitle': '会话排行',
    'settings.usage.ranking.metric.tokens': 'Tokens',
    'settings.usage.ranking.metric.cost': '费用',
    'settings.usage.ranking.metric.duration': '活跃',

    'settings.usage.composition.tokenTitle': 'Token 构成',
    'settings.usage.composition.timingTitle': '耗时构成',
    'settings.usage.composition.totalTokens': '估算总量',
    'settings.usage.composition.activeTime': '活跃时长',
    'settings.usage.composition.empty': '这段时间没有可拆分的用量',
    'settings.usage.composition.cacheNote': '缓存命中占计费输入 {rate}',
    'settings.usage.composition.timingNote': '按回合耗时拆解',

    'settings.usage.composition.systemPrompt': '系统提示词',
    'settings.usage.composition.toolDefinitions': '工具定义',
    'settings.usage.composition.conversation': '对话历史',
    'settings.usage.composition.toolResults': '工具结果',
    'settings.usage.composition.userPrompt': '用户消息',
    'settings.usage.composition.injections': '注入内容',
    'settings.usage.composition.output': '输出',

    'settings.usage.composition.wait': '模型等待',
    'settings.usage.composition.think': '模型思考',
    'settings.usage.composition.reply': '模型回复',
    'settings.usage.composition.tool': '工具执行',
    'settings.usage.composition.other': '参数与间隙',

    // Tool calls
    'settings.usage.tools.title': '工具调用',
    'settings.usage.tools.callsTitle': '调用次数',
    'settings.usage.tools.timeTitle': '耗时构成',
    'settings.usage.tools.timeTotal': '工具耗时',
    'settings.usage.tools.empty': '这段时间没有工具调用',
    'settings.usage.tools.total': '调用次数',
    'settings.usage.tools.distinct': '用到的工具',
    'settings.usage.tools.errorRate': '失败率',
    'settings.usage.tools.meanDuration': '平均耗时',
    'settings.usage.tools.more': '另有 {count} 个工具未列出',

    // Heatmap
    'settings.usage.heatmap.title': '使用热力图',
    'settings.usage.heatmap.yearSummary': '近一年活跃 {days} 天 · 共 {tokens} tokens',
    'settings.usage.heatmap.legendUnit': '每日请求',
    'settings.usage.heatmap.legendDay': '天',

    // Grouping and rankings
    'settings.usage.group.empty': '暂无数据',

    // Grouping switch
    'settings.usage.breakdown.by.model': '按模型',
    'settings.usage.breakdown.by.provider': '按供应商',

    // Call detail

    // Call details

    // Empty states

    // Context
} as const;

/** Usage page copy (en-US). */
export const usageMessagesEnUS = {
    'settings.nav.usage.label': 'Usage',
    'settings.nav.usage.description': 'Tokens, cost, and call audit',
    'settings.loading.usage': 'Loading usage statistics...',

    'settings.dataManagement.retention.title': 'Call detail retention',
    'settings.dataManagement.retention.description':
        'Historical call detail is pruned by this policy. Daily rollups are kept forever, so the All time trend is unaffected.',
    'settings.dataManagement.retention.label': 'Keep call detail for',
    'settings.dataManagement.retention.hint':
        'Nothing is deleted by default; pruning takes effect on the next start',
    'settings.dataManagement.retention.forever': 'Forever',
    'settings.dataManagement.retention.days': '{days} days',
    'settings.dataManagement.retention.saved': 'Saved — takes effect on the next start',

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

    'settings.usage.metric.cost': 'Total cost',
    'settings.usage.metric.costNote': 'Estimated from official prices',
    'settings.usage.metric.rpm': 'Mean RPM',
    'settings.usage.metric.rpmUnit': 'req/min',
    'settings.usage.metric.requests': 'Requests',
    'settings.usage.metric.requestsNote': '{rate} succeeded',
    'settings.usage.metric.sessions': 'Sessions',
    'settings.usage.metric.sessionsNote': 'Sessions with recorded usage',
    'settings.usage.metric.tokens': 'Tokens used',
    'settings.usage.metric.tokensNote': 'Including cache',
    'settings.usage.metric.tokensNoteWithLive': 'Including cache and the live turn',
    'settings.usage.metric.freshInput': 'Fresh input',
    'settings.usage.metric.output': 'Output',
    'settings.usage.metric.cacheRead': 'Cache read',
    'settings.usage.metric.cacheReadNote': 'Hit rate {rate}',
    'settings.usage.metric.cacheWrite': 'Cache write',
    'settings.usage.metric.activeDuration': 'Active time',
    'settings.usage.metric.activeDay': '{count} active day',
    'settings.usage.metric.activeDays': '{count} active days',
    'settings.usage.metric.activeDurationNote':
        'Sum of turn durations in this range, including concurrent turns; distinct active days use local dates',
    'settings.usage.duration.hour': 'h',
    'settings.usage.duration.minute': 'm',
    'settings.usage.duration.second': 's',
    'settings.usage.metric.reasoning': 'Reasoning',
    'settings.usage.metric.ttft': 'Mean first token',
    'settings.usage.metric.ttftNote': 'First-token latency',
    'settings.usage.metric.firstText': 'First text',
    'settings.usage.metric.firstTextNote': 'First visible text, excluding reasoning',
    'settings.usage.metric.unpriced': '{count} calls unpriced',

    'settings.usage.chart.title': 'Trend and breakdown',
    'settings.usage.chart.other': 'Other',
    'settings.usage.chart.total': 'Total',

    'settings.usage.live.activeSessions': '{count} sessions',

    'settings.usage.dashboardCurveTitle': 'Tokens used',
    'settings.usage.curve.liveWindow': 'last 15s',
    'settings.usage.curve.liveSpeed': 'live',
    'settings.usage.curve.avgSpeed': 'average',
    'settings.usage.curve.sessionCount': '{count} sessions',

    'settings.usage.ranking.modelTitle': 'Top models',
    'settings.usage.ranking.sessionTitle': 'Top sessions',
    'settings.usage.ranking.metric.tokens': 'Tokens',
    'settings.usage.ranking.metric.cost': 'Cost',
    'settings.usage.ranking.metric.duration': 'Active',

    'settings.usage.composition.tokenTitle': 'Token composition',
    'settings.usage.composition.timingTitle': 'Time composition',
    'settings.usage.composition.totalTokens': 'estimated total',
    'settings.usage.composition.activeTime': 'active time',
    'settings.usage.composition.empty': 'Nothing to break down in this range',
    'settings.usage.composition.cacheNote': 'Cache hits cover {rate} of billed input',
    'settings.usage.composition.timingNote': 'Split by turn duration',

    'settings.usage.composition.systemPrompt': 'System prompt',
    'settings.usage.composition.toolDefinitions': 'Tool definitions',
    'settings.usage.composition.conversation': 'Conversation',
    'settings.usage.composition.toolResults': 'Tool results',
    'settings.usage.composition.userPrompt': 'User messages',
    'settings.usage.composition.injections': 'Injected content',
    'settings.usage.composition.output': 'Output',

    'settings.usage.composition.wait': 'Model wait',
    'settings.usage.composition.think': 'Model thinking',
    'settings.usage.composition.reply': 'Model reply',
    'settings.usage.composition.tool': 'Tool run',
    'settings.usage.composition.other': 'Args and gaps',

    'settings.usage.tools.title': 'Tool calls',
    'settings.usage.tools.callsTitle': 'Calls',
    'settings.usage.tools.timeTitle': 'Time spent',
    'settings.usage.tools.timeTotal': 'Tool time',
    'settings.usage.tools.empty': 'No tool calls in this range',
    'settings.usage.tools.total': 'Calls',
    'settings.usage.tools.distinct': 'Tools used',
    'settings.usage.tools.errorRate': 'Failure rate',
    'settings.usage.tools.meanDuration': 'Mean duration',
    'settings.usage.tools.more': '{count} more tools not listed',

    'settings.usage.heatmap.title': 'Activity heatmap',
    'settings.usage.heatmap.yearSummary': '{days} active days · {tokens} tokens in the past year',
    'settings.usage.heatmap.legendUnit': 'Daily calls',
    'settings.usage.heatmap.legendDay': 'days',

    'settings.usage.trend.empty': 'No usage in this range',
    'settings.usage.trend.metric.tokens': 'Tokens',
    'settings.usage.trend.metric.requests': 'Requests',
    'settings.usage.trend.metric.cost': 'Cost',

    'settings.usage.group.empty': 'No data',

    'settings.usage.breakdown.by.model': 'By model',
    'settings.usage.breakdown.by.provider': 'By provider',
} as const;
