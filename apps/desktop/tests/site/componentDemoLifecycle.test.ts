import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureTouchaiLightDemoRuntime } from '../../../site/src/scripts/component-demo-runtime';

function deferredResponse() {
    let resolve!: (response: Response) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<Response>((complete, fail) => {
        resolve = complete;
        reject = fail;
    });
    return { promise, resolve, reject };
}

function mountDemo() {
    const element = document.createElement('touchai-component-demo');
    element.dataset.demoId = 'lifecycle';
    element.dataset.src = '/lifecycle-demo.html';
    element.dataset.loading = 'lazy';
    document.body.appendChild(element);
    const runtime = ensureTouchaiLightDemoRuntime();
    return { host: runtime.mount('lifecycle')!, runtime };
}

beforeEach(() => {
    delete window.__touchaiLightDemoRuntime;
});

afterEach(() => {
    delete window.__touchaiLightDemoRuntime;
    document.body.innerHTML = '';
    document.head
        .querySelectorAll('script[src*="lifecycle"]')
        .forEach((element) => element.remove());
    vi.unstubAllGlobals();
});

describe('user reloads a website component demo', () => {
    it('user reloads after removing the source and the existing demo is no longer ready without fetching again', async () => {
        const fetch = vi.fn().mockResolvedValue(new Response('<main>Existing demo</main>'));
        vi.stubGlobal('fetch', fetch);
        const { host } = mountDemo();
        await host.reload!();

        delete host.dataset.src;
        await host.reload!();

        expect(host.__touchaiReady).toBe(false);
        expect(host.dataset.touchaiReady).toBe('false');
        expect(host.textContent).toBe('Existing demo');
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('user removes the source during loading and the old response cannot publish the abandoned demo', async () => {
        const response = deferredResponse();
        vi.stubGlobal('fetch', vi.fn().mockReturnValue(response.promise));
        const { host } = mountDemo();
        const pending = host.reload!();

        delete host.dataset.src;
        await host.reload!();
        response.resolve(new Response('<main>Abandoned demo</main>'));
        await pending;

        expect(host.__touchaiReady).toBe(false);
        expect(host.__touchaiController).toBeNull();
        expect(host.textContent).toBe('');
    });

    it('user aborts the current demo load and its eventual response releases the request without becoming ready', async () => {
        const response = deferredResponse();
        vi.stubGlobal('fetch', vi.fn().mockReturnValue(response.promise));
        const { host } = mountDemo();
        const pending = host.reload!();

        host.__touchaiController!.abort();
        response.resolve(new Response('<main>Cancelled demo</main>'));
        await pending;

        expect(host.__touchaiReady).toBe(false);
        expect(host.__touchaiController).toBeNull();
        expect(host.textContent).toBe('');
    });

    it('user supersedes a fetch and its late success cannot mark the new load ready', async () => {
        const previous = deferredResponse();
        const current = deferredResponse();
        vi.stubGlobal(
            'fetch',
            vi.fn().mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise)
        );
        const { host } = mountDemo();
        const previousLoad = host.reload!();
        const currentLoad = host.reload!();

        previous.resolve(new Response('<main>Previous demo</main>'));
        await previousLoad;
        const prematureReady = host.__touchaiReady;
        current.resolve(new Response('<main>Current demo</main>'));
        await currentLoad;

        expect(prematureReady).toBe(false);
        expect(host.textContent).toBe('Current demo');
        expect(host.dataset.touchaiReady).toBe('true');
    });

    it('user completes a newer reload and an older fetch failure cannot replace its ready state', async () => {
        const previous = deferredResponse();
        vi.stubGlobal(
            'fetch',
            vi
                .fn()
                .mockReturnValueOnce(previous.promise)
                .mockResolvedValueOnce(new Response('<main>Current demo</main>'))
        );
        const { host } = mountDemo();
        const previousLoad = host.reload!();
        await host.reload!();

        previous.reject(new Error('superseded connection failed'));
        await previousLoad;

        expect(host.textContent).toBe('Current demo');
        expect(host.__touchaiReady).toBe(true);
        expect(host.dataset.touchaiStatus).toBe('ready');
        expect(host.dataset.touchaiError).toBeUndefined();
    });

    it('user replaces a demo waiting for a script and its old script failure cannot fail the replacement', async () => {
        vi.stubGlobal(
            'fetch',
            vi
                .fn()
                .mockResolvedValueOnce(
                    new Response(
                        '<main>Previous demo</main><script src="/lifecycle-slow.js"></script>'
                    )
                )
                .mockResolvedValueOnce(new Response('<main>Current demo</main>'))
        );
        const { host } = mountDemo();
        const previousLoad = host.reload!();
        await flushPromises();
        const previousScript = document.head.querySelector('script[src$="lifecycle-slow.js"]')!;
        expect(previousScript).not.toBeNull();
        await host.reload!();

        previousScript.dispatchEvent(new Event('error'));
        await previousLoad;

        expect(host.textContent).toBe('Current demo');
        expect(host.dataset.touchaiStatus).toBe('ready');
        expect(host.dataset.touchaiError).toBeUndefined();
    });

    it('user retries a failed demo and loading readiness matches the active request', async () => {
        const current = deferredResponse();
        vi.stubGlobal(
            'fetch',
            vi.fn().mockRejectedValueOnce(new Error('offline')).mockReturnValueOnce(current.promise)
        );
        const { host } = mountDemo();
        await host.reload!();
        expect(host.dataset.touchaiStatus).toBe('error');

        const pending = host.reload!();
        expect(host.__touchaiReady).toBe(false);
        current.resolve(new Response('<main>Retried demo</main>'));
        await pending;

        expect(host.textContent).toBe('Retried demo');
        expect(host.__touchaiReady).toBe(true);
        expect(host.dataset.touchaiError).toBeUndefined();
    });
});
