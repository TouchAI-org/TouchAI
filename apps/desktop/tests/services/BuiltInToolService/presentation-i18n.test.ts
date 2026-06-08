import { describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';

vi.mock('@/services/BuiltInToolService/registry', () => ({
    builtInToolRegistry: {
        get: (toolId: string) =>
            toolId === 'bash'
                ? {
                      id: 'bash',
                      displayName: 'Bash',
                      buildConversationSemantic: () => ({
                          action: 'process',
                          target: 'Bash',
                      }),
                  }
                : toolId === 'empty'
                  ? {
                        id: 'empty',
                        displayName: 'Empty',
                        buildConversationSemantic: () => null,
                    }
                  : null,
        list: () => [
            {
                id: 'bash',
                displayName: 'Bash',
            },
            {
                id: 'ghost',
                displayName: 'Ghost',
            },
            {
                id: 'empty',
                displayName: 'Empty',
            },
        ],
    },
}));

describe('BuiltInToolService presentation i18n', () => {
    it('localizes folded built-in tool verbs for the active runtime locale', async () => {
        const { buildBuiltInToolConversationPresentation } =
            await import('@/services/BuiltInToolService/presentation');

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

    it('normalizes prefixed and display-name tool identifiers', async () => {
        setLocale('en-US');
        const { buildBuiltInToolConversationPresentation } =
            await import('@/services/BuiltInToolService/presentation');

        expect(
            buildBuiltInToolConversationPresentation('builtin__bash', {}, 'completed')
        ).toMatchObject({
            verb: 'Processed',
            content: 'Bash',
        });
        expect(buildBuiltInToolConversationPresentation('not-a-tool', {}, 'completed')).toBeNull();
        expect(buildBuiltInToolConversationPresentation('   ', {}, 'completed')).toBeNull();
        expect(buildBuiltInToolConversationPresentation('Ghost', {}, 'completed')).toBeNull();
    });

    it('uses explicit semantic hints before default tool semantics', async () => {
        setLocale('en-US');
        const { buildBuiltInToolConversationPresentation, resolveBuiltInToolConversationSemantic } =
            await import('@/services/BuiltInToolService/presentation');

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

    it('returns null when a resolved tool has no semantic presentation', async () => {
        const { buildBuiltInToolConversationPresentation, resolveBuiltInToolConversationSemantic } =
            await import('@/services/BuiltInToolService/presentation');

        expect(resolveBuiltInToolConversationSemantic('   ', {})).toBeNull();
        expect(resolveBuiltInToolConversationSemantic('Ghost', {})).toBeNull();
        expect(resolveBuiltInToolConversationSemantic('Empty', {})).toBeNull();
        expect(buildBuiltInToolConversationPresentation('Empty', {}, 'completed')).toBeNull();
    });
});
