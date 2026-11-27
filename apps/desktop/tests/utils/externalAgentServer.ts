import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface A2ATestRequest {
    body: unknown;
    bodyText: string;
    headers: IncomingMessage['headers'];
    method: string;
    pathname: string;
    search: string;
}

export interface A2ATestRouteContext extends A2ATestRequest {
    response: ServerResponse;
    url: URL;
}

export interface A2ATestServer {
    baseUrl: string;
    requests: A2ATestRequest[];
    close(): Promise<void>;
    waitForRequest(
        predicate: (request: A2ATestRequest) => boolean,
        timeoutMs?: number
    ): Promise<A2ATestRequest>;
}

async function readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
}

export function json(response: ServerResponse, status: number, value: unknown): void {
    const body = JSON.stringify(value);
    response.writeHead(status, {
        'Content-Length': Buffer.byteLength(body),
        'Content-Type': 'application/json',
    });
    response.end(body);
}

export function sse(response: ServerResponse, chunks: readonly string[]): void {
    response.writeHead(200, {
        'Cache-Control': 'no-cache',
        'Content-Type': 'text/event-stream',
    });
    for (const chunk of chunks) response.write(chunk);
    response.end();
}

export function sseFrame(
    value: unknown,
    options: { crlf?: boolean; pretty?: boolean } = {}
): string {
    const eol = options.crlf ? '\r\n' : '\n';
    const lines = JSON.stringify(value, null, options.pretty ? 2 : undefined).split('\n');
    return `${lines.map((line) => `data: ${line}`).join(eol)}${eol}${eol}`;
}

export async function startA2ATestServer(
    route: (context: A2ATestRouteContext) => boolean | Promise<boolean>
): Promise<A2ATestServer> {
    const requests: A2ATestRequest[] = [];
    const sockets = new Set<import('node:net').Socket>();
    const waiters = new Set<{
        predicate: (request: A2ATestRequest) => boolean;
        resolve: (request: A2ATestRequest) => void;
    }>();
    const server = createServer(async (request, response) => {
        const bodyText = await readBody(request);
        let body: unknown = undefined;
        if (bodyText) {
            try {
                body = JSON.parse(bodyText);
            } catch {
                body = undefined;
            }
        }
        const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
        const captured: A2ATestRequest = {
            body,
            bodyText,
            headers: request.headers,
            method: request.method ?? 'GET',
            pathname: url.pathname,
            search: url.search,
        };
        requests.push(captured);
        for (const waiter of [...waiters]) {
            if (!waiter.predicate(captured)) continue;
            waiters.delete(waiter);
            waiter.resolve(captured);
        }
        try {
            const handled = await route({ ...captured, response, url });
            if (!handled) json(response, 404, { error: { message: 'not found' } });
        } catch {
            if (!response.headersSent)
                json(response, 500, { error: { message: 'fixture failed' } });
            else response.destroy();
        }
    });
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    const address = server.address() as AddressInfo;
    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests,
        async close() {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
        waitForRequest(predicate, timeoutMs = 2_000) {
            const existing = requests.find(predicate);
            if (existing) return Promise.resolve(existing);
            return new Promise((resolve, reject) => {
                const waiter = { predicate, resolve };
                waiters.add(waiter);
                setTimeout(() => {
                    if (!waiters.delete(waiter)) return;
                    reject(new Error('Timed out waiting for the A2A test server request'));
                }, timeoutMs);
            });
        },
    };
}
