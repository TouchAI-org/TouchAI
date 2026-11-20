// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * Responses 事件流的推理归一化。
 *
 * 官方 Responses API 只通过 `summary` 暴露思考过程，SDK 也只识别
 * `response.reasoning_summary_text.delta`。部分中转站把原始思维链放在
 * `content[].type = "reasoning_text"` 里，并以 `response.reasoning_text.delta`
 * 流式下发，SDK 会直接丢弃这类事件，导致界面看不到思考过程。
 *
 * 这里在 fetch 层把非标准事件改写成 SDK 认识的标准事件，出站请求参数不变。
 */

const REASONING_TEXT_DELTA = 'response.reasoning_text.delta';
const REASONING_SUMMARY_TEXT_DELTA = 'response.reasoning_summary_text.delta';

/** 把非标准推理增量改写为标准推理摘要增量；其余负载原样返回。 */
function rewritePayload(payload: string): string {
    let parsed: unknown;

    try {
        parsed = JSON.parse(payload);
    } catch {
        return payload;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return payload;
    }

    const event = parsed as Record<string, unknown>;
    if (event.type !== REASONING_TEXT_DELTA || typeof event.delta !== 'string') {
        return payload;
    }

    const summaryIndex = typeof event.content_index === 'number' ? event.content_index : 0;
    return JSON.stringify({
        ...event,
        type: REASONING_SUMMARY_TEXT_DELTA,
        summary_index: summaryIndex,
    });
}

/** 改写单行 SSE；非 data 行与无法解析的负载保持原样。 */
function rewriteLine(line: string): string {
    const body = line.replace(/[\r\n]+$/, '');
    const lineEnding = line.slice(body.length);

    if (!body.startsWith('data:')) {
        return line;
    }

    const payload = body.slice('data:'.length).trimStart();
    if (!payload || payload === '[DONE]') {
        return line;
    }

    // 只有可能被改写的事件才需要 JSON 解析；普通 data 行原样透传，
    // 避免逐行解析/重编码给流式响应增加无意义开销。
    if (!payload.includes(REASONING_TEXT_DELTA)) {
        return line;
    }

    const rewritten = rewritePayload(payload);
    return rewritten === payload ? line : `data: ${rewritten}${lineEnding}`;
}

/**
 * 把 Responses 事件流里的非标准推理增量改写为 SDK 认识的标准事件。
 *
 * 非事件流响应原样返回；按行处理，兼容跨 chunk 截断。
 */
export function normalizeResponsesReasoningStream(response: Response): Response {
    const contentType = response.headers.get('content-type') ?? '';

    if (!response.body || !contentType.includes('text/event-stream')) {
        return response;
    }

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let pending = '';

    const stream = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                pending += decoder.decode(chunk, { stream: true });

                let newlineIndex = pending.indexOf('\n');
                while (newlineIndex !== -1) {
                    const line = pending.slice(0, newlineIndex + 1);
                    pending = pending.slice(newlineIndex + 1);
                    controller.enqueue(encoder.encode(rewriteLine(line)));
                    newlineIndex = pending.indexOf('\n');
                }
            },
            flush(controller) {
                pending += decoder.decode();
                if (pending) {
                    controller.enqueue(encoder.encode(rewriteLine(pending)));
                }
            },
        })
    );

    return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
}
