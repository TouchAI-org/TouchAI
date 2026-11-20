import type { AiStreamChunk, AiToolCallDelta } from '@touchai/models/contracts';
import { parsePartialJson } from 'ai';

import { showWidgetRawArgsSchema } from './constants';
import { SHOW_WIDGET_DRAFT_MIN_INTERVAL_MS, SHOW_WIDGET_DRAFT_THROTTLE_MIN_CHARS } from './policy';
const SKILL_ACKNOWLEDGEMENT_FIELD = 'is_read_widget_skill';

const WIDGET_TOOL = 'builtin__show_widget';
const MAX_TRACKED_DRAFTS = 32;

export interface WidgetStreamOptions {
    signal: AbortSignal;
    publish(chunk: AiStreamChunk): void;
    reportError(error: unknown): void;
}

interface DraftState {
    at: number | null;
    length: number;
    revision: number;
    pending?: AiToolCallDelta;
    timer?: ReturnType<typeof setTimeout>;
}

/** One stream owns bounded leading/trailing pacing; final calls and cleanup invalidate pending parses. */
export function createPublicWidgetStream(input: WidgetStreamOptions) {
    const signal = input.signal;
    const publish = input.publish.bind(input);
    const reportError = input.reportError.bind(input);
    const sampled = new Map<string | number, DraftState>();
    let disposed = false;
    const clearPending = (state: DraftState) => {
        if (state.timer !== undefined) clearTimeout(state.timer);
        state.timer = undefined;
        state.pending = undefined;
        state.revision++;
    };
    const remove = (id: string | number) => {
        const state = sampled.get(id);
        if (state) clearPending(state);
        sampled.delete(id);
    };
    const clear = () => {
        for (const id of sampled.keys()) remove(id);
    };
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        clear();
        signal.removeEventListener('abort', dispose);
    };
    if (signal.aborted) dispose();
    else signal.addEventListener('abort', dispose, { once: true });

    const validate = async (delta: AiToolCallDelta): Promise<AiToolCallDelta | undefined> => {
        const { value, state } = await parsePartialJson(delta.argumentsBuffer);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return;
        const args = value as Record<string, unknown>;
        const fields = Object.keys(args);
        if (
            state !== 'successful-parse' &&
            fields[fields.length - 1] === SKILL_ACKNOWLEDGEMENT_FIELD
        )
            return;
        if (!showWidgetRawArgsSchema.safeParse(args).success) return;
        return { ...delta, argumentsDelta: undefined, argumentsBuffer: JSON.stringify(args) };
    };
    const isCurrent = (id: string | number, state: DraftState, revision: number) =>
        !disposed && sampled.get(id) === state && state.revision === revision;
    const defer = (
        id: string | number,
        state: DraftState,
        delta: AiToolCallDelta,
        delay: number
    ) => {
        state.revision++;
        state.pending = { ...delta };
        if (state.timer !== undefined) return;
        state.timer = setTimeout(
            () => {
                state.timer = undefined;
                const latest = state.pending;
                state.pending = undefined;
                if (!latest || disposed) return;
                const revision = state.revision;
                void validate(latest)
                    .then((projected) => {
                        if (projected && isCurrent(id, state, revision)) {
                            state.at = performance.now();
                            state.length = latest.argumentsBuffer.length;
                            publish({ content: '', done: false, toolCallDeltas: [projected] });
                        }
                    })
                    .catch((error: unknown) => {
                        if (isCurrent(id, state, revision)) {
                            try {
                                reportError(error);
                            } catch {
                                /* Passive diagnostics cannot change execution. */
                            }
                        }
                    });
            },
            Math.max(0, delay)
        );
    };

    const project = async (chunk: AiStreamChunk): Promise<AiStreamChunk> => {
        const deltas = [];
        for (const delta of chunk.toolCallDeltas ?? []) {
            if (delta.name !== WIDGET_TOOL) {
                deltas.push(delta);
                continue;
            }
            if (disposed) continue;
            const id = delta.callId ?? delta.index;
            // A provider may assign the call identity after its first indexed delta.
            if (delta.callId) remove(delta.index);
            let state = sampled.get(id);
            if (!state) {
                if (sampled.size >= MAX_TRACKED_DRAFTS) {
                    remove(sampled.keys().next().value!);
                }
                state = { at: null, length: 0, revision: 0 };
                sampled.set(id, state);
            }
            const now = performance.now();
            const large = delta.argumentsBuffer.length >= SHOW_WIDGET_DRAFT_THROTTLE_MIN_CHARS;
            if (
                !delta.isComplete &&
                !chunk.done &&
                large &&
                state.at !== null &&
                delta.argumentsBuffer.length >= state.length &&
                now - state.at < SHOW_WIDGET_DRAFT_MIN_INTERVAL_MS
            ) {
                defer(id, state, delta, SHOW_WIDGET_DRAFT_MIN_INTERVAL_MS - (now - state.at));
                continue;
            }
            clearPending(state);
            state.at = large ? now : null;
            state.length = delta.argumentsBuffer.length;
            const revision = state.revision;
            const projected = await validate(delta);
            if (projected && isCurrent(id, state, revision)) deltas.push(projected);
            if (delta.isComplete || chunk.done) remove(id);
        }
        const calls = (chunk.toolCalls ?? []).filter((call) => {
            if (call.name !== WIDGET_TOOL) return true;
            if (disposed) return false;
            try {
                return showWidgetRawArgsSchema.safeParse(JSON.parse(call.arguments)).success;
            } catch {
                return false;
            }
        });
        for (const call of chunk.toolCalls ?? []) remove(call.id);
        if (chunk.done) clear();
        return {
            ...chunk,
            ...(chunk.toolCallDeltas ? { toolCallDeltas: deltas } : {}),
            ...(chunk.toolCalls ? { toolCalls: calls } : {}),
        };
    };
    return Object.assign(project, { dispose });
}
