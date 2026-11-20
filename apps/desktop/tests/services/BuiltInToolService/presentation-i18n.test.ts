import { createToolsHostFixture } from '@tests/utils/toolsHost';
import { describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';

describe('user reads tool activity in their own language', () => {
    it.each([
        ['en-US', 'completed', 'Adjust window'],
        ['en-US', 'error', 'Adjust window'],
        ['zh-CN', 'completed', '调整窗口'],
        ['zh-CN', 'error', '调整窗口'],
    ] as const)(
        'user given a desktop action in %s when it is %s then sees its operation without a result suffix',
        async (locale, status, verb) => {
            setLocale(locale);
            const { host } = await createToolsHostFixture();
            const buildBuiltInToolConversationPresentation = host.presentation.presentation;
            expect(
                buildBuiltInToolConversationPresentation(
                    'builtin__computer_use',
                    {
                        action: 'call',
                        tool: 'set_window_frame',
                        arguments: { app: 'Notepad' },
                    },
                    status
                )
            ).toEqual({ verb, content: 'Notepad' });
        }
    );

    it('user reads built-in tool verbs in the active runtime language', async () => {
        const { host } = await createToolsHostFixture();
        const buildBuiltInToolConversationPresentation = host.presentation.presentation;

        const cases = [
            ['run', 'executing', 'Started'],
            ['run', 'error', 'Run failed'],
            ['run', 'completed', 'Ran'],
            ['search', 'executing', 'Searching'],
            ['search', 'error', 'Search failed'],
            ['search', 'completed', 'Searched'],
            ['read', 'executing', 'Reading'],
            ['read', 'error', 'Read failed'],
            ['read', 'completed', 'Read'],
            ['review', 'completed', 'Reviewed'],
            ['update', 'completed', 'Updated'],
            ['switch', 'completed', 'Switched'],
            ['render', 'completed', 'Rendered'],
            ['remove', 'completed', 'Removed'],
            ['process', 'executing', 'Processing'],
            ['process', 'error', 'Processing failed'],
            ['process', 'completed', 'Processed'],
            ['run', 'awaiting_approval', 'Pending'],
            ['run', 'rejected', 'Rejected'],
            ['run', 'cancelled', 'Cancelled'],
        ] as const;

        setLocale('en-US');

        for (const [action, status, expectedVerb] of cases) {
            expect(
                buildBuiltInToolConversationPresentation('Bash', {}, status, {
                    semantic: {
                        action,
                        target: 'echo hello',
                    },
                })?.verb
            ).toBe(expectedVerb);
        }
    }, 20_000);

    it('user sees prefixed and display-name tool identifiers recognized', async () => {
        setLocale('en-US');
        const { host } = await createToolsHostFixture();
        const buildBuiltInToolConversationPresentation = host.presentation.presentation;

        expect(
            buildBuiltInToolConversationPresentation(
                'builtin__bash',
                { command: 'echo hello' },
                'completed'
            )
        ).toMatchObject({
            verb: 'Ran',
            content: 'echo hello',
        });
        expect(buildBuiltInToolConversationPresentation('not-a-tool', {}, 'completed')).toBeNull();
        expect(buildBuiltInToolConversationPresentation('   ', {}, 'completed')).toBeNull();
        expect(buildBuiltInToolConversationPresentation('Ghost', {}, 'completed')).toBeNull();
    });

    it('user sees explicit semantic hints preferred over default tool semantics', async () => {
        setLocale('en-US');
        const { host } = await createToolsHostFixture();
        const buildBuiltInToolConversationPresentation = host.presentation.presentation;
        const resolveBuiltInToolConversationSemantic = host.presentation.resolveSemantic;

        expect(
            resolveBuiltInToolConversationSemantic(
                'bash',
                {},
                {
                    semantic: {
                        action: 'run',
                        target: 'result target',
                    },
                }
            )
        ).toEqual({
            action: 'run',
            target: 'result target',
        });
        expect(
            buildBuiltInToolConversationPresentation('bash', {}, 'completed', {
                semantic: {
                    action: 'run',
                    target: 'result target',
                },
            })
        ).toMatchObject({
            verb: 'Ran',
            content: 'result target',
        });
    });

    it('user sees no presentation when a name has no registered descriptor', async () => {
        const { host } = await createToolsHostFixture();
        const buildBuiltInToolConversationPresentation = host.presentation.presentation;
        const resolveBuiltInToolConversationSemantic = host.presentation.resolveSemantic;

        expect(resolveBuiltInToolConversationSemantic('   ', {})).toBeNull();
        expect(resolveBuiltInToolConversationSemantic('Ghost', {})).toBeNull();
        expect(resolveBuiltInToolConversationSemantic('Empty', {})).toBeNull();
        expect(buildBuiltInToolConversationPresentation('Empty', {}, 'completed')).toBeNull();
    });
});
