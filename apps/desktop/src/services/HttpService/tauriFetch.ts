// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

/**
 * 包装 ReadableStream，把上游 body 的读取交给下游 pull 驱动。
 *
 * 该包装持有一个 reader，并在 cancel 时调用 reader.cancel：
 * Tauri HTTP 插件的 body 一旦被 getReader() 锁定，直接调用 body.cancel()
 * 会被拒绝，上游请求也就无法真正停止。这里改为取消真正的 reader。
 *
 * 采用 pull 驱动而不是递归读取，避免下游读得慢时把整个响应
 * 一次性预取进无界缓冲，下游的 desiredSize 就是背压。
 *
 * Tauri HTTP 插件的 fetch_cancel_body 在资源已释放后再次调用会抛出
 * "The resource id xxx is invalid" 错误，这里吞掉重复 cancel 的异常。
 */
function wrapBodyStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    let settled = false;

    const releaseReader = (): void => {
        try {
            reader.releaseLock();
        } catch {
            // The reader may have been released already; nothing left to do.
        }
    };

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            let result: ReadableStreamReadResult<Uint8Array>;
            try {
                result = await reader.read();
            } catch (error) {
                if (settled) {
                    return;
                }
                settled = true;
                // A failed read leaves the native response body open unless the reader is
                // cancelled. The plugin also cancels in its own read failure path, but keep
                // this wrapper independent of that implementation detail.
                void reader.cancel().catch(() => undefined);
                releaseReader();
                controller.error(error);
                return;
            }

            if (settled) {
                return;
            }

            if (result.done) {
                settled = true;
                releaseReader();
                controller.close();
                return;
            }

            controller.enqueue(result.value);
        },
        cancel(reason) {
            if (settled) {
                return;
            }
            settled = true;
            return reader
                .cancel(reason)
                .catch(() => {
                    // 忽略重复 cancel 导致的 resource id invalid 错误
                })
                .finally(() => {
                    releaseReader();
                });
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
