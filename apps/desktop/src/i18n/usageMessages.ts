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

    // 明细保留（位于数据管理）
    'settings.dataManagement.retention.title': '调用明细保留',
    'settings.dataManagement.retention.description':
        '按此策略清理历史调用明细；日汇总永久保留，「全部时间」趋势不受影响。',
    'settings.dataManagement.retention.label': '保留调用明细',
    'settings.dataManagement.retention.hint': '默认不删除任何数据，清理在下次启动时生效',
    'settings.dataManagement.retention.forever': '永久保留',
    'settings.dataManagement.retention.days': '{days} 天',
    'settings.dataManagement.retention.saved': '已保存，下次启动时生效',

    'settings.usage.loadFailed': '用量数据加载失败，请稍后重试',
    'settings.usage.realtime': '数据随对话自动更新',

    // 明细保留
    'settings.usage.retention.title': '明细保留',
    'settings.usage.retention.description':
        '调用明细会在每次启动时按此策略清理；日汇总永久保留，「全部时间」趋势不受影响。',
    'settings.usage.retention.label': '保留调用明细',
    'settings.usage.retention.hint': '默认不删除任何数据；清理在下次启动时生效',
    'settings.usage.retention.forever': '永久保留',
    'settings.usage.retention.days': '{days} 天',
    'settings.usage.retention.saved': '已保存，下次启动时生效',
    // 分组统计表头
    'settings.usage.table.calls': '次数',
    'settings.usage.table.tokens': 'Tokens',
    'settings.usage.table.cacheRate': '缓存',
    'settings.usage.table.ttft': '首字',
    'settings.usage.table.cost': '成本',

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
    'settings.usage.metric.costNote': '基于官方价格估算',
    'settings.usage.metric.costNoteWithLive': '含本轮估算',
    'settings.usage.metric.rpm': '平均 RPM',
    'settings.usage.metric.rpmNote': '按活跃时长计',
    'settings.usage.metric.requests': '总请求',
    'settings.usage.metric.requestsNote': '成功率 {rate}',
    'settings.usage.metric.sessions': '会话数',
    'settings.usage.metric.sessionsNote': '产生过用量的会话',
    'settings.usage.metric.tokens': '消耗 Tokens',
    'settings.usage.metric.tokensNote': '含缓存读写',
    'settings.usage.metric.tokensNoteWithLive': '含缓存与本轮估算',
    'settings.usage.metric.cacheHitRate': '缓存命中率',
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
    'settings.usage.duration.millisecond': '毫秒',
    'settings.usage.metric.reasoning': '其中推理',
    'settings.usage.metric.ttft': '平均首字',
    'settings.usage.metric.ttftNote': '首 token 延迟',
    'settings.usage.metric.unpriced': '{count} 次调用未定价',

    // 趋势
    'settings.usage.trend.title': '使用趋势',
    'settings.usage.trend.empty': '这段时间没有用量',
    'settings.usage.trend.metric.tokens': 'Tokens',
    'settings.usage.trend.metric.requests': '请求',
    'settings.usage.trend.metric.cost': '成本',

    // 趋势图（含分布）
    'settings.usage.chart.title': '使用趋势与分布',
    'settings.usage.chart.other': '其他',

    // 实时面板
    'settings.usage.live.title': '实时用量',
    'settings.usage.live.throughput': '吞吐',
    'settings.usage.live.stream': '流',
    'settings.usage.live.online': '进行中',
    'settings.usage.live.idle': '空闲',
    'settings.usage.live.waiting': '等待下一次对话',
    'settings.usage.live.activeStreams': '{count} 路响应中',
    'settings.usage.live.total': '合计',
    'settings.usage.live.elapsed': '已用时',
    'settings.usage.live.cost': '成本',
    'settings.usage.live.ttft': '首字 {value}',
    'settings.usage.live.stopped': '已结束',
    'settings.usage.live.estimateNote':
        '流式期间的 token 与成本按已流入字符估算；结束时 token 换成实测值。',
    'settings.usage.live.estimateNoteShort': '估算值',
    'settings.usage.live.estimatedTokens': '估算，含推理',
    'settings.usage.live.streaming': '正在流式',

    // 统一仪表盘
    'settings.usage.dashboardHistoryTitle': '用量概览',
    'settings.usage.dashboardCurveTitle': '用量曲线',

    // 排行
    'settings.usage.ranking.modelTitle': '模型',
    'settings.usage.ranking.sessionTitle': '最耗会话',
    'settings.usage.ranking.metric.tokens': 'Tokens',
    'settings.usage.ranking.metric.cost': '费用',
    'settings.usage.ranking.metric.duration': '活跃',
    'settings.usage.dashboardHistoryNote': '汇总所选区间的用量，对话进行中时持续更新当前时间桶。',

    // 工具调用
    'settings.usage.tools.title': '工具调用',
    'settings.usage.tools.description': '数据来自工具调用片段，含内置工具与 MCP 工具。',
    'settings.usage.tools.empty': '这段时间没有工具调用',
    'settings.usage.tools.total': '调用次数',
    'settings.usage.tools.distinct': '用到的工具',
    'settings.usage.tools.errorRate': '失败率',
    'settings.usage.tools.meanDuration': '平均耗时',
    'settings.usage.tools.builtin': '内置',
    'settings.usage.tools.mcp': 'MCP',
    'settings.usage.tools.more': '另有 {count} 个工具未列出',
    'settings.usage.tools.column.tool': '工具',
    'settings.usage.tools.column.calls': '次数',
    'settings.usage.tools.column.share': '占比',
    'settings.usage.tools.column.errorRate': '失败率',
    'settings.usage.tools.column.duration': '平均耗时',

    // 热力图
    'settings.usage.heatmap.title': '使用热力图',
    'settings.usage.heatmap.summary': '所选区间活跃 {days} 天 · 共 {tokens} tokens',
    'settings.usage.heatmap.lastYear': '近一年活跃 {days} 天 · 共 {tokens} tokens',
    'settings.usage.heatmap.tooltip': '{day} · {requests} 次 · {tokens} tokens · {cost}',
    'settings.usage.heatmap.less': '少',
    'settings.usage.heatmap.more': '多',

    // 分组/排行
    'settings.usage.group.byModel': '按模型',
    'settings.usage.group.byProvider': '按供应商',
    'settings.usage.group.empty': '暂无数据',

    // 分组切换
    'settings.usage.breakdown.title': '用量分布',
    'settings.usage.breakdown.by.model': '按模型',
    'settings.usage.breakdown.by.provider': '按供应商',

    // 调用明细
    'settings.usage.call.title': '调用明细',
    'settings.usage.call.tokens': '{value} tokens',
    'settings.usage.call.outcome.completed': '完成',
    'settings.usage.call.outcome.failed': '失败',
    'settings.usage.call.outcome.truncated': '被截断',
    'settings.usage.calls.empty': '这段时间没有调用记录',
    'settings.usage.calls.unpriced': '未定价',
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

    // 上下文
    'settings.usage.context.title': '上下文健康度',
    'settings.usage.context.description':
        '按模型看窗口占用、固定开销与缓存复用。总量取自供应商返回的真实用量，分段为估算。',
    'settings.usage.context.empty': '还没有可统计的上下文数据',
    'settings.usage.context.overallScore': '综合评分',
    'settings.usage.context.breakdown': '评分构成',
    'settings.usage.context.composition': '本轮上下文构成',
    'settings.usage.context.estimateNote': '堆叠总高度取自真实用量，各分段按字符估算（≈）',
    'settings.usage.context.turns': '{count} 轮采样',
    'settings.usage.context.all': '全部模型',

    'settings.usage.context.score.cache': '缓存复用',
    'settings.usage.context.score.lean': '起步精简',
    'settings.usage.context.score.pace': '增长节奏',
    'settings.usage.context.score.reliable': '调用可靠',

    'settings.usage.context.segment.systemPrompt': '系统提示',
    'settings.usage.context.segment.builtinToolDefinitions': '内置工具',
    'settings.usage.context.segment.mcpToolDefinitions': 'MCP 工具',
    'settings.usage.context.segment.conversation': '对话历史',
    'settings.usage.context.segment.userPrompt': '用户输入',
    'settings.usage.context.segment.attachments': '附件',

    'settings.usage.context.column.model': '模型',
    'settings.usage.context.column.turns': '轮次',
    'settings.usage.context.column.median': '中位',
    'settings.usage.context.column.p90': 'P90',
    'settings.usage.context.column.baseline': '基线',
    'settings.usage.context.column.window': '窗口',
    'settings.usage.context.column.peak': '峰值',
    'settings.usage.context.column.cache': '缓存',
    'settings.usage.context.column.compacts': '压缩',
    'settings.usage.context.column.score': '评分',

    'settings.usage.context.tag.cacheFriendly': '缓存友好',
    'settings.usage.context.tag.cacheMisses': '缓存未命中多',
    'settings.usage.context.tag.lean': '起步精简',
    'settings.usage.context.tag.heavyStart': '起步太重',
    'settings.usage.context.tag.mcpHeavy': 'MCP 占窗口多',
    'settings.usage.context.tag.fillsFast': '上下文涨得快',
    'settings.usage.context.tag.nearFull': '接近满窗',
    'settings.usage.context.tag.compacts': '发生过压缩',
    'settings.usage.context.tag.attachmentHeavy': '附件占用多',
    'settings.usage.context.tag.promptBloat': '输入过长',
    'settings.usage.context.tag.steady': '稳定',
    'settings.usage.context.tag.flaky': '不稳定',
} as const;

/** 用量统计页的文案（en-US） */
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
    'settings.usage.realtime': 'Updates automatically as you chat',

    'settings.usage.retention.title': 'Detail retention',
    'settings.usage.retention.description':
        'Call detail is pruned on startup according to this policy. Daily rollups are kept forever, so the All time trend is unaffected.',
    'settings.usage.retention.label': 'Keep call detail for',
    'settings.usage.retention.hint':
        'Nothing is deleted by default; pruning takes effect on the next start',
    'settings.usage.retention.forever': 'Forever',
    'settings.usage.retention.days': '{days} days',
    'settings.usage.retention.saved': 'Saved — takes effect on the next start',

    'settings.usage.table.calls': 'Calls',
    'settings.usage.table.tokens': 'Tokens',
    'settings.usage.table.cacheRate': 'Cache',
    'settings.usage.table.ttft': 'TTFT',
    'settings.usage.table.cost': 'Cost',

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
    'settings.usage.metric.costNote': 'Estimated from official prices',
    'settings.usage.metric.costNoteWithLive': 'Including the live turn',
    'settings.usage.metric.rpm': 'Mean RPM',
    'settings.usage.metric.rpmNote': 'Per active minute',
    'settings.usage.metric.requests': 'Requests',
    'settings.usage.metric.requestsNote': '{rate} succeeded',
    'settings.usage.metric.sessions': 'Sessions',
    'settings.usage.metric.sessionsNote': 'Sessions with recorded usage',
    'settings.usage.metric.tokens': 'Tokens used',
    'settings.usage.metric.tokensNote': 'Including cache',
    'settings.usage.metric.tokensNoteWithLive': 'Including cache and the live turn',
    'settings.usage.metric.cacheHitRate': 'Cache hit rate',
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
    'settings.usage.duration.millisecond': 'ms',
    'settings.usage.metric.reasoning': 'Reasoning',
    'settings.usage.metric.ttft': 'Mean first token',
    'settings.usage.metric.ttftNote': 'First-token latency',
    'settings.usage.metric.unpriced': '{count} calls unpriced',

    'settings.usage.chart.title': 'Trend and breakdown',
    'settings.usage.chart.other': 'Other',

    'settings.usage.live.title': 'Live usage',
    'settings.usage.live.throughput': 'Throughput',
    'settings.usage.live.stream': 'Stream',
    'settings.usage.live.online': 'live',
    'settings.usage.live.idle': 'idle',
    'settings.usage.live.waiting': 'Waiting for the next conversation',
    'settings.usage.live.activeStreams': '{count} active',
    'settings.usage.live.total': 'total',
    'settings.usage.live.elapsed': 'elapsed',
    'settings.usage.live.cost': 'cost',
    'settings.usage.live.ttft': 'first token {value}',
    'settings.usage.live.stopped': 'finished',
    'settings.usage.live.estimateNote':
        'Token and cost are estimated from streamed characters while streaming; tokens switch to the measured value at the end.',
    'settings.usage.live.estimateNoteShort': 'estimated',
    'settings.usage.live.estimatedTokens': 'estimated, incl. reasoning',
    'settings.usage.live.streaming': 'streaming',

    'settings.usage.dashboardHistoryTitle': 'Usage overview',
    'settings.usage.dashboardCurveTitle': 'Usage curve',

    'settings.usage.ranking.modelTitle': 'Models',
    'settings.usage.ranking.sessionTitle': 'Top sessions',
    'settings.usage.ranking.metric.tokens': 'Tokens',
    'settings.usage.ranking.metric.cost': 'Cost',
    'settings.usage.ranking.metric.duration': 'Active',
    'settings.usage.dashboardHistoryNote':
        'Usage for the selected range; the current time bucket updates as conversations run.',

    'settings.usage.tools.title': 'Tool calls',
    'settings.usage.tools.description':
        'Recorded from tool-call parts, covering built-in and MCP tools.',
    'settings.usage.tools.empty': 'No tool calls in this range',
    'settings.usage.tools.total': 'Calls',
    'settings.usage.tools.distinct': 'Tools used',
    'settings.usage.tools.errorRate': 'Failure rate',
    'settings.usage.tools.meanDuration': 'Mean duration',
    'settings.usage.tools.builtin': 'Built-in',
    'settings.usage.tools.mcp': 'MCP',
    'settings.usage.tools.more': '{count} more tools not listed',
    'settings.usage.tools.column.tool': 'Tool',
    'settings.usage.tools.column.calls': 'Calls',
    'settings.usage.tools.column.share': 'Share',
    'settings.usage.tools.column.errorRate': 'Failure',
    'settings.usage.tools.column.duration': 'Duration',

    'settings.usage.heatmap.title': 'Activity heatmap',
    'settings.usage.heatmap.summary': '{days} active days · {tokens} tokens in this range',
    'settings.usage.heatmap.lastYear': '{days} active days · {tokens} tokens in the past year',
    'settings.usage.heatmap.tooltip': '{day} · {requests} calls · {tokens} tokens · {cost}',
    'settings.usage.heatmap.less': 'Less',
    'settings.usage.heatmap.more': 'More',

    'settings.usage.trend.title': 'Usage trend',
    'settings.usage.trend.empty': 'No usage in this range',
    'settings.usage.trend.metric.tokens': 'Tokens',
    'settings.usage.trend.metric.requests': 'Requests',
    'settings.usage.trend.metric.cost': 'Cost',

    'settings.usage.group.byModel': 'By model',
    'settings.usage.group.byProvider': 'By provider',
    'settings.usage.group.empty': 'No data',

    'settings.usage.breakdown.title': 'Usage breakdown',
    'settings.usage.breakdown.by.model': 'By model',
    'settings.usage.breakdown.by.provider': 'By provider',

    'settings.usage.call.title': 'Call audit',
    'settings.usage.call.tokens': '{value} tokens',
    'settings.usage.call.outcome.completed': 'Completed',
    'settings.usage.call.outcome.failed': 'Failed',
    'settings.usage.call.outcome.truncated': 'Truncated',
    'settings.usage.calls.empty': 'No calls in this range',
    'settings.usage.calls.unpriced': 'Unpriced',
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

    'settings.usage.context.title': 'Context health',
    'settings.usage.context.description':
        'Per-model window usage, fixed overhead, and cache reuse. Totals come from the provider; segments are estimates.',
    'settings.usage.context.empty': 'No context data to summarise yet',
    'settings.usage.context.overallScore': 'Overall score',
    'settings.usage.context.breakdown': 'Score breakdown',
    'settings.usage.context.composition': 'Current context composition',
    'settings.usage.context.estimateNote':
        'Total height uses real usage; each segment is estimated from characters (≈)',
    'settings.usage.context.turns': '{count} turns sampled',
    'settings.usage.context.all': 'All models',

    'settings.usage.context.score.cache': 'Cache reuse',
    'settings.usage.context.score.lean': 'Lean start',
    'settings.usage.context.score.pace': 'Growth pace',
    'settings.usage.context.score.reliable': 'Reliability',

    'settings.usage.context.segment.systemPrompt': 'System prompt',
    'settings.usage.context.segment.builtinToolDefinitions': 'Built-in tools',
    'settings.usage.context.segment.mcpToolDefinitions': 'MCP tools',
    'settings.usage.context.segment.conversation': 'Conversation',
    'settings.usage.context.segment.userPrompt': 'User input',
    'settings.usage.context.segment.attachments': 'Attachments',

    'settings.usage.context.column.model': 'Model',
    'settings.usage.context.column.turns': 'Turns',
    'settings.usage.context.column.median': 'Median',
    'settings.usage.context.column.p90': 'P90',
    'settings.usage.context.column.baseline': 'Baseline',
    'settings.usage.context.column.window': 'Window',
    'settings.usage.context.column.peak': 'Peak',
    'settings.usage.context.column.cache': 'Cache',
    'settings.usage.context.column.compacts': 'Compacts',
    'settings.usage.context.column.score': 'Score',

    'settings.usage.context.tag.cacheFriendly': 'Cache friendly',
    'settings.usage.context.tag.cacheMisses': 'Frequent cache misses',
    'settings.usage.context.tag.lean': 'Lean start',
    'settings.usage.context.tag.heavyStart': 'Heavy start',
    'settings.usage.context.tag.mcpHeavy': 'MCP heavy',
    'settings.usage.context.tag.fillsFast': 'Fills fast',
    'settings.usage.context.tag.nearFull': 'Near full',
    'settings.usage.context.tag.compacts': 'Compacts',
    'settings.usage.context.tag.attachmentHeavy': 'Attachment heavy',
    'settings.usage.context.tag.promptBloat': 'Long input',
    'settings.usage.context.tag.steady': 'Steady',
    'settings.usage.context.tag.flaky': 'Flaky',
} as const;
