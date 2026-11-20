import type { ToolsOptions } from '../contracts';
import type { ToolMessages } from '../contracts/host';

/** Host-bound wording for the unified pipeline, not a second dispatch path. */
export function createToolFormatting(input: ToolMessages) {
    const tt = input.tt.bind(input);
    const t = input.t.bind(input);
    const formatError: ToolsOptions['formatError'] = (code, details, context) => {
        const toolName = context?.toolName ?? '';
        if (code === 'tool_unavailable') return tt('未找到工具：{toolName}', { toolName });
        if (code === 'request_cancelled') return tt('请求已取消');
        if (code === 'approval_rejected') return t('conversation.approval.userRejectedCommand');
        if (code === 'skill_context_limit') return t('skills.contextLimit', { count: 16 });
        if (code === 'invalid_arguments') {
            if (context?.invalidArguments === 'json')
                return tt('工具参数协议错误：{toolName} 返回了无效的 JSON 参数。', { toolName });
            if (context?.invalidArguments === 'shape') {
                const issues = context.issues
                    ?.map((issue) => {
                        const path = issue.path.length ? issue.path.map(String).join('.') : 'input';
                        return `- "${path}": ${issue.message}`;
                    })
                    .join('\n');
                return `${tt('工具参数协议错误：{toolName} 必须接收 JSON 对象。', { toolName })}\n${issues ?? ''}`;
            }
            return tt('工具执行失败：{error}', { error: details ?? code });
        }
        // Unexpected native errors may contain credentials; report a stable category.
        return t('builtInTools.presentation.process.error');
    };
    return Object.freeze({ formatError });
}
