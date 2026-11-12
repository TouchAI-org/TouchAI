import { createRequire } from 'node:module';

import { afterEach, vi } from 'vitest';

import { createWidgetRenderer as createRenderer } from '@/services/BuiltInToolService/tools/widgetTool/showWidget/runtime';

const { JSDOM, VirtualConsole } = createRequire(import.meta.url)('jsdom') as typeof import('jsdom');
const frames = new Map<HTMLElement, InstanceType<typeof JSDOM>>();
let loadResource: ((url: string, target: Window) => void) | undefined;

export function mockWidgetScriptResource(handler: (url: string, target: Window) => void) {
    loadResource = handler;
}

/** JSDOM does not load srcdoc. Only that browser boundary is supplied here. */
export function createWidgetRenderer(host: HTMLElement) {
    const renderer = createRenderer(host);
    const iframe = host.querySelector('iframe')!;
    const parent = {
        postMessage(data: unknown) {
            window.dispatchEvent(
                new MessageEvent('message', { data, source: iframe.contentWindow })
            );
        },
    };
    const frame = new JSDOM(iframe.srcdoc, {
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        virtualConsole: new VirtualConsole(),
        beforeParse(target) {
            Object.defineProperty(target, 'parent', { value: parent });
            const append = target.Element.prototype.append;
            target.Element.prototype.append = function (...nodes) {
                append.apply(this, nodes);
                for (const node of nodes) {
                    if (node instanceof target.HTMLScriptElement && node.src) {
                        queueMicrotask(() => {
                            loadResource?.(node.src, target as unknown as Window);
                            node.dispatchEvent(new target.Event('load'));
                        });
                    }
                }
            };
        },
    });
    frames.set(host, frame);
    vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation((data) => {
        frame.window.dispatchEvent(
            new frame.window.MessageEvent('message', { data, source: parent as unknown as Window })
        );
    });
    iframe.dispatchEvent(new Event('load'));
    return {
        render: renderer.render,
        destroy() {
            renderer.destroy();
            frame.window.close();
            frames.delete(host);
        },
    };
}

export function widgetDocument(host: HTMLElement): Document {
    return frames.get(host)!.window.document;
}

export function widgetWindow(host: HTMLElement): Window {
    return frames.get(host)!.window as unknown as Window;
}

afterEach(() => {
    frames.forEach((frame) => frame.window.close());
    frames.clear();
    loadResource = undefined;
});
