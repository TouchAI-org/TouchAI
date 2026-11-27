import type { AiToolCall } from '@touchai/models/contracts';
import { Ajv } from 'ajv';

import { z } from '@/utils/zod';

import type {
    PreparedTool,
    ToolAudit,
    ToolFailureCode,
    ToolInvocationScope,
    ToolOutcome,
    ToolRegistration,
    ToolsOptions,
} from '../contracts';
import { prepareDeclaration } from '../registry/snapshot';

const toolArgumentsSchema = z.record(z.string(), z.unknown());

export class ToolExecutionError extends Error {
    constructor(
        readonly outcome: ToolOutcome,
        options?: ErrorOptions
    ) {
        super(outcome.result, options);
        this.name = 'ToolExecutionError';
    }
}

function waitLocally<T>(
    promise: Promise<T>,
    signal: AbortSignal
): Promise<{ value: T } | { cancelled: true }> {
    return new Promise((resolve, reject) => {
        const abort = () => {
            signal.removeEventListener('abort', abort);
            resolve({ cancelled: true });
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
        // Keep rejection handlers attached after cancellation; late remote completion is not authoritative.
        promise.then(
            (value) => {
                signal.removeEventListener('abort', abort);
                resolve({ value });
            },
            (error) => {
                signal.removeEventListener('abort', abort);
                reject(error);
            }
        );
    });
}

function executePipeline(
    options: ToolsOptions,
    lifetime: AbortSignal,
    binding?: {
        registration: ToolRegistration;
        prepared: ReturnType<typeof prepareDeclaration>;
        validate(args: Record<string, unknown>): boolean;
        validationDetails(): string;
        authorize: PreparedTool['authorize'];
        approval?: PreparedTool['approval'];
        describe?: PreparedTool['describe'];
        approvalRejected?: PreparedTool['approvalRejected'];
        effect: PreparedTool['execute'];
    }
) {
    return async (call: AiToolCall, requested: ToolInvocationScope): Promise<ToolOutcome> => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        const signals = [lifetime, requested.signal].filter(
            (signal): signal is AbortSignal => signal !== undefined
        );
        for (const signal of signals) {
            if (signal.aborted) controller.abort();
            else signal.addEventListener('abort', abort, { once: true });
        }
        const signal = controller.signal;
        let startedEffect = false;
        let audit: ToolAudit | undefined;
        let finishing = false;
        const context: NonNullable<Parameters<ToolsOptions['formatError']>[2]> = {
            toolName: call.name,
        };
        const error = (code: ToolFailureCode, details?: string, unknown = false): ToolOutcome => ({
            result: options.formatError(code, details, context),
            isError: true,
            failureCode: code,
            sideEffect: unknown ? 'unknown' : 'none',
        });
        const finish = async (outcome: ToolOutcome) => {
            const observed = {
                ...outcome,
                ...(audit?.receiptKey ? { receiptKey: audit.receiptKey } : {}),
                ...(audit?.input !== undefined ? { input: audit.input } : {}),
            };
            finishing = true;
            await audit?.finish(observed);
            finishing = false;
            return observed;
        };
        try {
            let parsed: unknown;
            let malformedJson = false;
            try {
                parsed = JSON.parse(call.arguments);
            } catch {
                malformedJson = true;
            }
            const shape = toolArgumentsSchema.safeParse(parsed);
            const validObject = shape.success;
            const sanitized =
                binding && validObject
                    ? binding.prepared.sanitize(shape.data)
                    : { args: validObject ? shape.data : {}, timeout: undefined };
            const scope: ToolInvocationScope = {
                ...requested,
                callId: call.id,
                signal,
                requestedTimeoutMs: sanitized.timeout,
            };
            // Rejections are part of committed history too; admission never implies authorization.
            audit = await options.beginAudit?.(
                call,
                validObject ? sanitized.args : call.arguments,
                scope
            );
            if (signal.aborted) return await finish(error('request_cancelled'));
            if (!validObject) {
                context.invalidArguments = malformedJson ? 'json' : 'shape';
                context.issues = shape.error.issues;
                return await finish({ ...error('invalid_arguments'), argumentParseFailed: true });
            }
            if (!binding) return await finish(error('tool_unavailable'));
            if (!binding.validate(sanitized.args)) {
                context.invalidArguments = 'schema';
                return await finish(error('invalid_arguments', binding.validationDetails()));
            }
            if (!(await binding.authorize(scope, sanitized.args)) || signal.aborted) {
                return await finish(
                    error(signal.aborted ? 'request_cancelled' : 'tool_unavailable')
                );
            }
            const semantic = await binding.describe?.(sanitized.args, scope);
            await audit?.started?.(semantic);
            if (
                scope.restriction === 'skill_context_limit' &&
                binding.registration.controlIntent === 'activate_skill'
            ) {
                return await finish(error('skill_context_limit'));
            }
            const decision = await binding.approval?.(sanitized.args, scope);
            if (decision) {
                await audit?.approval?.(decision);
                if (signal.aborted) return await finish(error('request_cancelled'));
                const resolved = await waitLocally(
                    scope.requestApproval?.(call.id, decision) ?? Promise.resolve(false),
                    signal
                );
                const approved = 'value' in resolved && resolved.value;
                await audit?.approval?.(decision, approved);
                if (signal.aborted) return await finish(error('request_cancelled'));
                if (!approved) {
                    await binding.approvalRejected?.(sanitized.args, scope);
                    return await finish(error('approval_rejected'));
                }
                scope.approvalGranted = true;
            }
            if (!(await binding.authorize(scope, sanitized.args)) || signal.aborted) {
                return await finish(
                    error(signal.aborted ? 'request_cancelled' : 'tool_unavailable')
                );
            }
            startedEffect = true;
            const resolved = await waitLocally(binding.effect(sanitized.args, scope), signal);
            if (!('value' in resolved) || signal.aborted)
                return await finish(error('request_cancelled', undefined, true));
            const result = resolved.value;
            if (
                result.control &&
                (binding.registration.source !== 'builtin' ||
                    result.control.type !== binding.registration.controlIntent)
            ) {
                return await finish(error('invalid_control', undefined, true));
            }
            return await finish({ ...result, sideEffect: result.sideEffect ?? 'completed' });
        } catch (cause) {
            const outcome = error(
                signal.aborted ? 'request_cancelled' : 'execution_failed',
                cause instanceof Error ? cause.message : undefined,
                startedEffect
            );
            // A failed barrier cannot acknowledge an effect or authorize its replay.
            if (finishing || !audit) throw new ToolExecutionError(outcome, { cause });
            try {
                return await finish(outcome);
            } catch (saveFailure) {
                throw new ToolExecutionError(outcome, { cause: saveFailure });
            }
        } finally {
            for (const inputSignal of signals) inputSignal.removeEventListener('abort', abort);
        }
    };
}

export function bindUnavailableExecution(options: ToolsOptions, lifetime: AbortSignal) {
    return executePipeline(options, lifetime);
}

export function bindExecution(
    registration: ToolRegistration,
    input: PreparedTool,
    options: ToolsOptions,
    lifetime: AbortSignal
) {
    const prepared = prepareDeclaration(input.declaration);
    if (prepared.declaration.name !== registration.name)
        throw new Error('Tool declaration binding mismatch');
    // Validators are snapshot-scoped: edited schemas cannot change an in-flight binding.
    const validation = new Ajv({ strict: false, allErrors: true, validateFormats: false });
    const validator = validation.compile(prepared.businessSchema);
    return {
        declaration: prepared.declaration,
        execute: executePipeline(options, lifetime, {
            registration,
            prepared,
            validate: (args) => validator(args),
            authorize: input.authorize.bind(input),
            validationDetails: () => validation.errorsText(validator.errors, { separator: '\n' }),
            approval: input.approval?.bind(input),
            describe: input.describe?.bind(input),
            approvalRejected: input.approvalRejected?.bind(input),
            effect: input.execute.bind(input),
        }),
    };
}
