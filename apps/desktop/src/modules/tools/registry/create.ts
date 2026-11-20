import type { AiToolCall } from '@touchai/models/contracts';

import { awaitAbortable, combineAbortSignals } from '@/utils/abort';

import type {
    ToolInvocationScope,
    ToolPreparationScope,
    ToolRegistration,
    ToolSnapshot,
    ToolsOptions,
} from '../contracts';
import { bindExecution, bindUnavailableExecution } from '../execution/pipeline';

function validateRegistration(registration: ToolRegistration, names: Set<string>): void {
    if (names.has(registration.name)) throw new Error(`Duplicate tool name: ${registration.name}`);
    names.add(registration.name);
    if (registration.source === 'mcp' && !/^mcp__\d+__.+$/.test(registration.name)) {
        throw new Error('MCP cannot register builtin or non-namespaced tool names');
    }
    if (registration.source === 'builtin' && !registration.name.startsWith('builtin__')) {
        throw new Error('Builtin tool name must be namespaced');
    }
    if (
        registration.controlIntent &&
        (registration.source !== 'builtin' ||
            registration.name !== `builtin__${registration.controlIntent}`)
    ) {
        throw new Error('Untrusted tool control intent');
    }
}

export function createTools(input: ToolsOptions) {
    const names = new Set<string>();
    const registrations = input.registrations.map((registration) => {
        validateRegistration(registration, names);
        return Object.freeze({ ...registration, prepare: registration.prepare.bind(registration) });
    });
    const options: ToolsOptions = {
        registrations,
        formatError: input.formatError.bind(input),
        beginAudit: input.beginAudit?.bind(input),
    };
    const prepareMcpTools = input.mcp?.prepareTools.bind(input.mcp);
    const lifetime = new AbortController();
    return Object.freeze({
        async snapshot(
            selection: {
                excludedNames?: readonly string[];
                preparation?: ToolPreparationScope;
                enabled?: boolean;
                beginAudit?: ToolsOptions['beginAudit'];
                signal?: AbortSignal;
            } = {}
        ): Promise<ToolSnapshot> {
            if (lifetime.signal.aborted) throw new Error('Tools module disposed');
            const combined = combineAbortSignals([selection.signal, lifetime.signal]);
            const { signal } = combined;
            try {
                signal.throwIfAborted();
                const catalog =
                    selection.enabled === false || !prepareMcpTools
                        ? []
                        : await awaitAbortable(prepareMcpTools, signal);
                signal.throwIfAborted();
                const snapshotNames = new Set(names);
                const dynamic = catalog.map((registration) => {
                    if (registration.source !== 'mcp')
                        throw new Error('MCP catalog cannot register builtins');
                    validateRegistration(registration, snapshotNames);
                    return Object.freeze({
                        ...registration,
                        prepare: registration.prepare.bind(registration),
                    });
                });
                const excluded = new Set(selection.excludedNames);
                const executionOptions: ToolsOptions = {
                    ...options,
                    beginAudit: selection.beginAudit?.bind(selection) ?? options.beginAudit,
                };
                const bindings = new Map<string, ReturnType<typeof bindExecution>>();
                for (const registration of [...registrations, ...dynamic]) {
                    signal.throwIfAborted();
                    if (selection.enabled === false || excluded.has(registration.name)) continue;
                    const prepared = await awaitAbortable(
                        () => registration.prepare(selection.preparation),
                        signal
                    );
                    signal.throwIfAborted();
                    if (prepared)
                        bindings.set(
                            registration.name,
                            bindExecution(registration, prepared, executionOptions, lifetime.signal)
                        );
                }
                if (lifetime.signal.aborted) throw new Error('Tools module disposed');
                const unavailable = bindUnavailableExecution(executionOptions, lifetime.signal);
                return Object.freeze({
                    declarations: Object.freeze(
                        [...bindings.values()].map((binding) => binding.declaration)
                    ),
                    execute: (call: AiToolCall, scope: ToolInvocationScope) => {
                        const binding = bindings.get(call.name);
                        return binding ? binding.execute(call, scope) : unavailable(call, scope);
                    },
                });
            } finally {
                combined.dispose();
            }
        },
        dispose() {
            lifetime.abort();
        },
    });
}

export type ToolsModule = ReturnType<typeof createTools>;
