// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

/**
 * 包装 ReadableStream，使 cancel 操作幂等
 * Tauri HTTP 插件的 fetch_cancel_body 在资源已释放后再次调用会抛出
 * "The resource id xxx is invalid" 错误，这里吞掉重复 cancel 的异常
 */
function wrapBodyStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    let cancelled = false;
    let closed = false;
    return new ReadableStream<Uint8Array>({
        start(controller) {
            const reader = body.getReader();
            function pump(): void {
                reader.read().then(
                    ({ done, value }) => {
                        if (cancelled || closed) {
                            return;
                        }
                        if (done) {
                            closed = true;
                            controller.close();
                            return;
                        }
                        try {
                            controller.enqueue(value);
                            pump();
                        } catch (err) {
                            // 流已关闭，忽略 enqueue 错误
                            if (!closed) {
                                controller.error(err);
                            }
                        }
                    },
                    (err) => {
                        if (!closed) {
                            controller.error(err);
                        }
                    }
                );
            }
            pump();
        },
        cancel(reason) {
            if (cancelled) return;
            cancelled = true;
            closed = true;
            return body.cancel(reason).catch(() => {
                // 忽略重复 cancel 导致的 resource id invalid 错误
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
