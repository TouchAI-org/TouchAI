import {
    createBuiltInTool,
    findAllBuiltInTools,
    findBuiltInToolByToolId,
    touchBuiltInToolLastUsed,
} from '@database/queries/builtInTools';

import type { ToolInvocationScope, ToolRegistration } from '../contracts';
import type {
    AdditionalBuiltInRegistration,
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

function createAdditionalRegistration(entry: AdditionalBuiltInRegistration): ToolRegistration {
    return {
        name: entry.registration.name,
        source: 'builtin',
        async prepare(preparation) {
            if ((await findBuiltInToolByToolId(entry.id))?.enabled !== 1) return null;
            const prepared = await entry.registration.prepare(preparation);
            if (!prepared) return null;
            return {
                ...prepared,
                authorize: async (scope, args) =>
                    (await findBuiltInToolByToolId(entry.id))?.enabled === 1 &&
                    (await prepared.authorize(scope, args)),
                execute: async (args, scope) => {
                    const result = await prepared.execute(args, scope);
                    await touchBuiltInToolLastUsed(entry.id);
                    return result;
                },
            };
        },
    };
}

/** Descriptors and their configuration live in this single Desktop registry. */
export function createBuiltinRegistrations(
    input: BuiltInToolGroup,
    additional: readonly AdditionalBuiltInRegistration[] = []
) {
    const descriptors = [...input];
    const names = new Set<string>();
    for (const descriptor of descriptors) {
        const name = `builtin__${descriptor.id}`;
        if (names.has(name)) throw new Error(`Duplicate tool name: ${name}`);
        names.add(name);
    }
    for (const entry of additional) {
        const expectedName = `builtin__${entry.id}`;
        if (entry.registration.name !== expectedName)
            throw new Error(`Builtin registration name must be ${expectedName}`);
        if (names.has(expectedName)) throw new Error(`Duplicate tool name: ${expectedName}`);
        names.add(expectedName);
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
    registrations.push(...additional.map(createAdditionalRegistration));
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
            for (const tool of additional)
                if (!stored.has(tool.id)) {
                    await createBuiltInTool({
                        tool_id: tool.id,
                        display_name: tool.displayName,
                        description: tool.description,
                        enabled: 1,
                        risk_level: tool.riskLevel,
                        config_json:
                            tool.defaultConfig === undefined || tool.defaultConfig === null
                                ? null
                                : JSON.stringify(tool.defaultConfig),
                    });
                }
        },
    });
}
