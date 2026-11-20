import type {
    ConfiguredModel,
    ConfiguredModelConnection,
    ModelSelection,
    ModelsModule,
    ModelSummary,
} from '@/modules/models';
import { ModelConfigurationError } from '@/modules/models';
import type { ToolModelReference } from '@/modules/tools';

interface ModelScope {
    models: Map<string, ConfiguredModel>;
    leases: Set<ConfiguredModelConnection>;
}

export interface TaskModelBindingOptions {
    selection: Pick<ModelSelection, 'get' | 'isCurrent' | 'touch'>;
    connections: Pick<ModelsModule, 'acquireConnection'>;
}

/** Resource handles are task-scoped; configuration authority remains in Desktop models. */
export function createTaskModelBindings(options: TaskModelBindingOptions) {
    const select = options.selection.get.bind(options.selection);
    const isCurrent = options.selection.isCurrent.bind(options.selection);
    const touch = options.selection.touch.bind(options.selection);
    const acquire = options.connections.acquireConnection.bind(options.connections);
    const scopes = new Map<string, ModelScope>();
    let disposed = false;
    const requireScope = (taskId: string): ModelScope => {
        const scope = scopes.get(taskId);
        if (disposed || !scope) throw new Error('MODEL_BINDING_NOT_FOUND');
        return scope;
    };
    const reference = (key: string, model: ConfiguredModel): ToolModelReference => ({
        key,
        id: model.summary.modelDbId,
        provider_id: model.summary.providerId,
        provider_name: model.summary.providerName,
        model_id: model.summary.modelId,
        name: model.summary.modelName,
        supportsImages: model.capabilities.supportsImages,
    });
    const register = (scope: ModelScope, model: ConfiguredModel) => {
        const key = crypto.randomUUID();
        scope.models.set(key, structuredClone(model));
        return reference(key, model);
    };
    function disposeTask(taskId: string): void {
        const scope = scopes.get(taskId);
        if (!scope) return;
        scopes.delete(taskId);
        scope.models.clear();
        const errors: unknown[] = [];
        for (const connection of scope.leases) {
            try {
                connection.dispose();
            } catch (error) {
                errors.push(error);
            }
        }
        scope.leases.clear();
        if (errors.length) throw new AggregateError(errors, 'MODEL_BINDING_CLEANUP_FAILED');
    }

    return Object.freeze({
        async start(
            taskId: string,
            selected?: { providerId?: number; modelId?: string }
        ): Promise<ToolModelReference> {
            if (disposed || scopes.has(taskId)) throw new Error('MODEL_BINDING_ALREADY_STARTED');
            const scope: ModelScope = { models: new Map(), leases: new Set() };
            scopes.set(taskId, scope);
            try {
                const model = await select(selected);
                if (disposed || scopes.get(taskId) !== scope)
                    throw new Error('MODEL_BINDING_NOT_FOUND');
                return register(scope, model);
            } catch (error) {
                if (scopes.get(taskId) === scope) scopes.delete(taskId);
                throw error;
            }
        },
        async resolveTarget(
            taskId: string,
            selected: { providerId: number; modelId: string }
        ): Promise<ToolModelReference | null> {
            const scope = scopes.get(taskId);
            if (disposed || !scope) return null;
            const model = await select(selected);
            if (disposed || scopes.get(taskId) !== scope) return null;
            const previous = [...scope.models].find(
                ([, entry]) =>
                    entry.summary.modelDbId === model.summary.modelDbId &&
                    JSON.stringify(entry.connection) === JSON.stringify(model.connection) &&
                    JSON.stringify(entry.capabilities) === JSON.stringify(model.capabilities)
            );
            return previous ? reference(previous[0], previous[1]) : register(scope, model);
        },
        async isAvailable(taskId: string, selected: ToolModelReference): Promise<boolean> {
            const scope = disposed ? undefined : scopes.get(taskId);
            const model = scope?.models.get(selected.key);
            if (
                !scope ||
                !model ||
                model.summary.modelDbId !== selected.id ||
                model.summary.providerId !== selected.provider_id ||
                model.summary.modelId !== selected.model_id
            )
                return false;
            const available = await isCurrent(model);
            return available && !disposed && scopes.get(taskId) === scope;
        },
        describe(taskId: string, key: string): ModelSummary | null {
            const model = disposed ? undefined : scopes.get(taskId)?.models.get(key);
            return model ? { ...model.summary } : null;
        },
        recordUse(taskId: string, key: string): Promise<void> {
            const model = requireScope(taskId).models.get(key);
            if (!model) throw new Error('MODEL_BINDING_NOT_FOUND');
            return touch(model.summary.modelDbId);
        },
        async acquire(taskId: string, key: string) {
            const scope = requireScope(taskId);
            const model = scope.models.get(key);
            if (!model) throw new Error('MODEL_BINDING_NOT_FOUND');
            if (!(await isCurrent(model)))
                throw new ModelConfigurationError('PROVIDER_BINDING_REVOKED');
            if (requireScope(taskId) !== scope) throw new Error('MODEL_BINDING_NOT_FOUND');
            const connection = acquire(model.connection);
            scope.leases.add(connection);
            return Object.freeze({
                key,
                model: structuredClone(model),
                connection,
                release() {
                    scope.leases.delete(connection);
                    connection.dispose();
                },
            });
        },
        disposeTask,
        dispose() {
            if (disposed) return;
            disposed = true;
            const errors: unknown[] = [];
            for (const taskId of scopes.keys()) {
                try {
                    disposeTask(taskId);
                } catch (error) {
                    errors.push(error);
                }
            }
            if (errors.length) throw new AggregateError(errors, 'MODEL_BINDING_CLEANUP_FAILED');
        },
    });
}

export type TaskModelBindings = ReturnType<typeof createTaskModelBindings>;
export type TaskModelLease = Awaited<ReturnType<TaskModelBindings['acquire']>>;
