import type { AiRequestOptions, AiStreamChunk } from '@touchai/models/contracts';

import type { AgentMessage } from '../contracts/agent';
import { AgentError } from '../contracts/agent';
import { throwIfCancelled } from './retry';

export function transportRequest(
    input: AiRequestOptions & { connectionKey?: string }
): AiRequestOptions {
    const request = { ...input };
    delete request.connectionKey;
    return {
        ...request,
        messages: input.messages.map((message: AgentMessage) => ({
            role: message.role,
            content: message.content,
            ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
            ...(message.tool_call_id !== undefined ? { tool_call_id: message.tool_call_id } : {}),
            ...(message.name !== undefined ? { name: message.name } : {}),
            ...(message.isError !== undefined ? { isError: message.isError } : {}),
        })),
    };
}

function nextChunk(
    iterator: AsyncIterator<AiStreamChunk>,
    signal: AbortSignal
): Promise<IteratorResult<AiStreamChunk>> {
    throwIfCancelled(signal);
    return new Promise((resolve, reject) => {
        const abort = () => {
            signal.removeEventListener('abort', abort);
            reject(new AgentError('REQUEST_CANCELLED'));
        };
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve()
            .then(() => iterator.next())
            .then(resolve, reject)
            .finally(() => signal.removeEventListener('abort', abort));
    });
}

export async function* consumeStream(
    source: AsyncIterable<AiStreamChunk>,
    signal: AbortSignal
): AsyncGenerator<AiStreamChunk> {
    const iterator = source[Symbol.asyncIterator]();
    try {
        while (true) {
            const result = await nextChunk(iterator, signal);
            throwIfCancelled(signal);
            if (result.done) return;
            yield result.value;
        }
    } finally {
        // Local cancellation cannot wait for a remote iterator that ignores abort.
        try {
            void Promise.resolve(iterator.return?.()).catch(() => undefined);
        } catch {
            /* The lease owns remote cleanup. */
        }
    }
}
