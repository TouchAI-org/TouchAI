import {
    createBuiltInTool,
    findAllBuiltInTools,
    findBuiltInToolByToolId,
    touchBuiltInToolLastUsed,
} from '@database/queries/builtInTools';

import type { ToolInvocationScope, ToolRegistration } from '../contracts';
import type {
    BaseBuiltInToolExecutionContext,
    BuiltInTool,
    BuiltInToolGroup,
    BuiltInToolId,
} from '../contracts/builtin';

const RISK_LEVELS: Record<BuiltInToolId, 'low' | 'medium' | 'high'> = {
    activate_skill: 'medium',
    bash: 'high',
    file_search: 'low',
    read: 'medium',
    setting: 'medium',
    web_search: 'low',
    web_fetch: 'low',
    upgrade_model: 'medium',
    show_widget: 'low',
    visualize_read_me: 'low',
    ask_user_question: 'low',
    browser: 'medium',
    browser_session: 'medium',
    browser_observe: 'low',
    browser_act: 'high',
    computer_use: 'high',
};

function executionContext(scope: ToolInvocationScope): BaseBuiltInToolExecutionContext {
    if (!scope.callId) throw new Error('TOOL_CALL_ID_MISSING');
    return {
        callId: scope.callId,
        iteration: scope.iteration,
        signal: scope.signal,
        taskSignal: scope.task?.signal,
        stopTask: scope.task?.stop.bind(scope.task),
        currentModel: scope.task?.currentModel,
        approvalGranted: scope.approvalGranted,
        requestedTimeoutMs: scope.requestedTimeoutMs,
        requestUserQuestions: scope.task?.ask.bind(scope.task),
        emitToolEvent: scope.task
            ? (event) => {
                  if (!scope.signal?.aborted) scope.task!.present(event);
              }
            : undefined,
    };
}

/** Descriptors and their configuration live in this single Desktop registry. */
export function createBuiltinRegistrations(input: BuiltInToolGroup) {
    const descriptors = [...input];
    const ids = new Set<string>();
    for (const descriptor of descriptors) {
        if (ids.has(descriptor.id))
            throw new Error(`Duplicate tool name: builtin__${descriptor.id}`);
        ids.add(descriptor.id);
    }
    const registrations: ToolRegistration[] = descriptors.map((descriptor: BuiltInTool) => ({
        name: `builtin__${descriptor.id}`,
        source: 'builtin',
        ...(descriptor.id === 'upgrade_model' || descriptor.id === 'activate_skill'
            ? { controlIntent: descriptor.id }
            : {}),
        async prepare(preparation) {
            const row = await findBuiltInToolByToolId(descriptor.id);
            if (row?.enabled !== 1) return null;
            const config = structuredClone(descriptor.parseConfig(row.config_json));
            const tool = await descriptor.prepareForTurn(config, preparation);
            const name = `builtin__${tool.id}`;
            return {
                declaration: await tool.buildToolDefinition(name, config),
                authorize: async (scope) =>
                    (await findBuiltInToolByToolId(tool.id))?.enabled === 1 &&
                    (await tool.isAuthorized(scope)),
                describe: async (args, scope) =>
                    tool.buildConversationSemanticWithContext(
                        args,
                        config,
                        executionContext(scope)
                    ),
                approval: async (args, scope) =>
                    tool.buildApprovalRequest(args, config, name, executionContext(scope)),
                approvalRejected: async (args, scope) =>
                    tool.recordApprovalRejected(args, config, executionContext(scope)),
                execute: async (args, scope) => {
                    const { controlSignal, ...result } = await tool.execute(
                        args,
                        config,
                        executionContext(scope)
                    );
                    await touchBuiltInToolLastUsed(tool.id);
                    const control =
                        controlSignal?.type === 'upgrade_model'
                            ? {
                                  type: 'upgrade_model' as const,
                                  targetKey: controlSignal.targetModel.key,
                                  restart: controlSignal.restartCurrentRequest,
                              }
                            : controlSignal;
                    return { ...result, ...(control ? { control } : {}) };
                },
            };
        },
    }));
    return Object.freeze({
        registrations,
        async synchronize() {
            const stored = new Set((await findAllBuiltInTools()).map((row) => row.tool_id));
            for (const tool of descriptors)
                if (!stored.has(tool.id)) {
                    await createBuiltInTool({
                        tool_id: tool.id,
                        display_name: tool.displayName,
                        description: tool.description,
                        enabled: 1,
                        risk_level: RISK_LEVELS[tool.id],
                        config_json: JSON.stringify(tool.defaultConfig),
                    });
                }
        },
    });
}
