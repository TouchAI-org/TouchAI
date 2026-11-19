import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, describe, expect, it } from 'vitest';

import type { ToolEvent, ToolTaskContext } from '@/modules/tools';
import {
    createBuiltinRegistrations,
    createShowWidgetTools,
    createTools,
    ToolExecutionError,
} from '@/modules/tools';

afterEach(closeTestDatabases);

async function fixture() {
    routeQueriesTo(openMigratedDatabase());
    const events: ToolEvent[] = [];
    const catalog = createBuiltinRegistrations(
        createShowWidgetTools({
            messages: { t: (key) => key, tt: (text) => text },
            markup: {
                inspect(html) {
                    const template = document.createElement('template');
                    template.innerHTML = html;
                    const parsed = new DOMParser().parseFromString(html, 'text/html');
                    return {
                        firstElementTag: template.content.firstElementChild?.tagName ?? null,
                        baseUrl: document.baseURI,
                        resourceUrls: [
                            ...parsed.querySelectorAll(
                                'script[src],link[href],img[src],audio[src],video[src],source[src],track[src],iframe[src],embed[src],object[data]'
                            ),
                        ].map(
                            (element) =>
                                element.getAttribute('src') ||
                                element.getAttribute('href') ||
                                element.getAttribute('data') ||
                                ''
                        ),
                    };
                },
            },
        })
    );
    await catalog.synchronize();
    const tools = createTools({
        registrations: catalog.registrations,
        formatError: (code) => code,
    });
    const controller = new AbortController();
    const task: ToolTaskContext = {
        taskId: 'task',
        attemptToken: 'attempt',
        attemptGeneration: 1,
        signal: controller.signal,
        stop: () => controller.abort(),
        historyTarget: { sessionId: 1, messageId: 1 },
        currentModel: {
            key: 'fixture',
            id: 1,
            provider_id: 1,
            provider_name: 'Fixture',
            model_id: 'fixture',
            name: 'Fixture',
            supportsImages: false,
        },
        ask: async () => null,
        present: (event) => events.push(event),
    };
    return { tools, events, task };
}

describe('given widget processing and the DOM inspection boundary have separate owners', () => {
    it('user receives a widget event while its model-visible tool result contains only the existing semantic summary', async () => {
        const { tools, events, task } = await fixture();
        try {
            const outcome = await (
                await tools.snapshot()
            ).execute(
                {
                    id: 'widget',
                    name: 'builtin__show_widget',
                    arguments:
                        '{"is_read_widget_skill":true,"widget_code":"<section>Fixture chart</section>","title":"Fixture"}',
                },
                { iteration: 0, task }
            );
            expect(outcome).toMatchObject({ isError: false, status: 'success' });
            expect(events).toContainEqual(
                expect.objectContaining({
                    type: 'widget_upsert',
                    widgetId: 'widget',
                    html: '<section>Fixture chart</section>',
                    title: 'Fixture',
                    phase: 'ready',
                })
            );
            expect(outcome.result).toContain('HTML 字符数');
            expect(outcome.result).not.toContain('<section>');
        } finally {
            tools.dispose();
        }
    });

    it.each([
        { is_read_widget_skill: false, widget_code: '<section>Hidden</section>' },
        {
            is_read_widget_skill: true,
            widget_code: '<style>.root{}</style><section>Hidden</section>',
        },
        {
            is_read_widget_skill: true,
            widget_code: '<section><img src="https://unapproved.invalid/image.png"></section>',
        },
    ])(
        'user sees no widget change when acknowledgement or existing markup restrictions reject the request %#',
        async (args) => {
            const { tools, events, task } = await fixture();
            try {
                const outcome = await (
                    await tools.snapshot()
                )
                    .execute(
                        {
                            id: 'widget',
                            name: 'builtin__show_widget',
                            arguments: JSON.stringify(args),
                        },
                        { iteration: 0, task }
                    )
                    .catch((error: unknown) => {
                        expect(error).toBeInstanceOf(ToolExecutionError);
                        return (error as ToolExecutionError).outcome;
                    });
                expect(outcome.isError).toBe(true);
                expect(events.filter((event) => event.type === 'widget_upsert')).toEqual([]);
            } finally {
                tools.dispose();
            }
        }
    );
});
