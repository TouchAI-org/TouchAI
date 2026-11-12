import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

import { createWidgetSandboxDocument } from '@/services/BuiltInToolService/tools/widgetTool/showWidget/sandbox';

const { JSDOM, VirtualConsole } = createRequire(import.meta.url)('jsdom') as typeof import('jsdom');
const frames: InstanceType<typeof JSDOM>[] = [];

function createFrame() {
    const frame = new JSDOM(createWidgetSandboxDocument('test-scope', ''), {
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        virtualConsole: new VirtualConsole(),
    });
    frames.push(frame);
    return frame;
}

function render(
    frame: InstanceType<typeof JSDOM>,
    signature: string,
    scripts: Array<{ source?: string; src?: string }>
) {
    frame.window.dispatchEvent(
        new frame.window.MessageEvent('message', {
            source: frame.window as unknown as Window,
            data: {
                type: 'render',
                scopeId: 'test-scope',
                phase: 'ready',
                signature,
                html: '<button id="answer" data-widget-key="answer">Waiting</button>',
                scripts: scripts.map((script) => ({
                    source: '',
                    src: '',
                    attributes: [],
                    ...script,
                })),
            },
        })
    );
}

afterEach(() => frames.splice(0).forEach((frame) => frame.window.close()));

describe('given a generated widget is updated in its isolated execution frame', () => {
    it('user gets newly initialized behavior when updated scripts reuse lexical names', () => {
        const frame = createFrame();
        render(frame, 'one', [
            {
                source: "const answer = 1; document.getElementById('answer').onclick = () => window.sendPrompt(String(answer));",
            },
        ]);
        const button = frame.window.document.getElementById('answer')!;
        const prompts: string[] = [];
        Object.assign(frame.window, { sendPrompt: (text: string) => prompts.push(text) });
        button.click();
        render(frame, 'two', [
            {
                source: "const answer = 2; document.getElementById('answer').onclick = () => window.sendPrompt(String(answer));",
            },
        ]);
        expect(frame.window.document.getElementById('answer')).toBe(button);
        button.click();
        expect(prompts).toEqual(['1', '2']);
    });

    it('user gets one completed initialization when an identical update arrives during a library download', async () => {
        const frame = createFrame();
        const scripts = [
            { src: 'https://cdn.jsdelivr.net/test.js' },
            {
                source: "document.getElementById('answer').textContent = 'Ready'; window.initializations = (window.initializations || 0) + 1;",
            },
        ];
        render(frame, 'same', scripts);
        render(frame, 'same', scripts);
        frame.window.document
            .querySelector('script[src]')!
            .dispatchEvent(new frame.window.Event('load'));
        await Promise.resolve();
        expect(frame.window.document.getElementById('answer')?.textContent).toBe('Ready');
        expect(Reflect.get(frame.window, 'initializations')).toBe(1);
        render(frame, 'same', scripts);
        expect(frame.window.document.getElementById('answer')?.textContent).toBe('Ready');
        expect(Reflect.get(frame.window, 'initializations')).toBe(1);
    });

    it('user gets only the latest initialization when a changed update replaces a pending download', async () => {
        const frame = createFrame();
        render(frame, 'old', [
            { src: 'https://cdn.jsdelivr.net/test.js' },
            { source: "document.getElementById('answer').textContent = 'Old';" },
        ]);
        const pending = frame.window.document.querySelector('script[src]')!;
        render(frame, 'new', [
            { source: "document.getElementById('answer').textContent = 'New';" },
        ]);
        pending.dispatchEvent(new frame.window.Event('load'));
        await Promise.resolve();
        expect(frame.window.document.getElementById('answer')?.textContent).toBe('New');
    });
});
