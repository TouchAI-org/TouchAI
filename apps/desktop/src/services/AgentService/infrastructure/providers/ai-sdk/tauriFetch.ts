// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

/**
 * 把 Tauri HTTP 响应体包装成按需拉取的流。
 *
 * 两个必须保持的契约：
 * 1. 只有下游 `pull()` 时才读取上游，避免快网络把未消费的 chunk 全部堆进队列；
 * 2. 取消作用于持有锁的 reader 本身，而不是再次 `body.cancel()`。
 *    Tauri 的 `fetch_cancel_body` 在资源已释放后重复调用会抛
 *    "The resource id xxx is invalid"，所以取消需要幂等。
 */
function wrapBodyStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    let settled = false;

    const releaseReader = () => {
        try {
            reader.releaseLock();
        } catch {
            // reader 可能尚未释放完读取；释放失败不应影响已确定的终态。
        }
    };

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (settled) {
                return;
            }

            try {
                const { done, value } = await reader.read();
                if (settled) {
                    return;
                }

                if (done) {
                    settled = true;
                    controller.close();
                    releaseReader();
                    return;
                }

                controller.enqueue(value);
            } catch (error) {
                if (settled) {
                    return;
                }
                settled = true;
                controller.error(error);
                releaseReader();
            }
        },
        cancel(reason) {
            if (settled) {
                return undefined;
            }
            settled = true;

            // 上游可能已经释放；重复取消只会得到 resource id invalid，可安全忽略。
            return reader.cancel(reason).catch(() => undefined);
        },
    });
}

export function createTauriFetch(): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url =
            typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        const response = await tauriFetch(url, init);

        if (!response.body) return response;

        const wrappedBody = wrapBodyStream(response.body);
        return new Response(wrappedBody, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    }) as typeof fetch;
}
