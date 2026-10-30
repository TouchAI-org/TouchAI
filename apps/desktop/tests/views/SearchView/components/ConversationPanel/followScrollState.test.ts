import { describe, expect, it } from 'vitest';

import {
    type FollowScrollInput,
    resolveFollowScrollState,
} from '@/views/SearchView/components/ConversationPanel/followScrollState';

function input(overrides: Partial<FollowScrollInput> = {}): FollowScrollInput {
    return {
        mode: 'follow_output',
        atBottom: false,
        hasScrollbar: true,
        scrolledUp: false,
        isProgrammatic: false,
        hasRecentUserIntent: false,
        isFollowing: true,
        ...overrides,
    };
}

describe('user scrolls up while output is streaming', () => {
    it('stops following once the user scrolls up', () => {
        const result = resolveFollowScrollState(
            input({ scrolledUp: true, hasRecentUserIntent: true })
        );

        expect(result).toEqual({ isFollowing: false, showScrollToBottom: true });
    });

    it('keeps following stopped while layout compensation moves the viewport', () => {
        // 窗口化插入/移除 spacer 后 scrollTop 被程序性改写，甚至可能正好落到“底部”。
        for (const overrides of [
            { isProgrammatic: true, hasRecentUserIntent: true },
            { isProgrammatic: true, atBottom: true, hasRecentUserIntent: false },
            { isProgrammatic: false, atBottom: true, hasRecentUserIntent: false },
        ]) {
            const result = resolveFollowScrollState(
                input({ isFollowing: false, scrolledUp: true, ...overrides })
            );

            expect(result.isFollowing).toBe(false);
        }
    });

    it('resumes following only when the user scrolls back to the bottom', () => {
        expect(
            resolveFollowScrollState(
                input({
                    isFollowing: false,
                    atBottom: true,
                    scrolledUp: false,
                    hasRecentUserIntent: true,
                })
            ).isFollowing
        ).toBe(true);
    });

    it('does not resume on a programmatic jump to the bottom', () => {
        expect(
            resolveFollowScrollState(
                input({
                    isFollowing: false,
                    atBottom: true,
                    isProgrammatic: true,
                    hasRecentUserIntent: true,
                })
            ).isFollowing
        ).toBe(false);
    });
});

describe('jump_to_top mode', () => {
    it('never follows output regardless of position', () => {
        for (const atBottom of [true, false]) {
            const result = resolveFollowScrollState(
                input({ mode: 'jump_to_top', atBottom, isFollowing: true })
            );

            expect(result.isFollowing).toBe(false);
        }
    });
});

describe('content that fits the viewport', () => {
    it('keeps following without showing the jump button', () => {
        expect(resolveFollowScrollState(input({ hasScrollbar: false, atBottom: false }))).toEqual({
            isFollowing: true,
            showScrollToBottom: false,
        });
    });
});
