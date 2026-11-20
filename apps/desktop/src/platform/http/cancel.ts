// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 取消一个尚未读取、即将被丢弃的响应 body，释放底层 native reader。
 *
 * wrapper 改成 pull 驱动后不再主动 drain：不读取就丢弃的响应不会自行排空，
 * native body 资源会一直挂着。丢弃路径必须显式取消；取消失败（body 已消费、
 * 已释放或被锁定）一律吞掉，绝不能掩盖调用方原本要抛出的 HTTP 业务错误。
 */
export async function cancelResponseBody(response: Response, reason?: string): Promise<void> {
    try {
        await response.body?.cancel(reason);
    } catch {
        // The body may be consumed, locked or already released; never mask the caller's result.
    }
}
