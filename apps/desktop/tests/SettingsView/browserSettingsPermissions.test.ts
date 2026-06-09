import { describe, expect, it } from 'vitest';

import { DEFAULT_BROWSER_SETTINGS } from '@/stores/setting/sections/browser';
import {
    evaluateBrowserPermission,
    fixedBrowserDescription,
    normalizeBrowserDescription,
    requiresBrowserDescription,
} from '@/stores/setting/sections/browserPermissions';

describe('browser settings permissions', () => {
    it('uses fixed descriptions for passive status operations only', () => {
        expect(requiresBrowserDescription('status')).toBe(false);
        expect(requiresBrowserDescription('tabs')).toBe(false);
        expect(requiresBrowserDescription('current')).toBe(false);
        expect(fixedBrowserDescription('status')).toBe('查看浏览器状态');
        expect(fixedBrowserDescription('tabs')).toBe('查看浏览器标签页');
        expect(fixedBrowserDescription('current')).toBe('查看当前页面');

        expect(requiresBrowserDescription('navigate')).toBe(true);
        expect(requiresBrowserDescription('click')).toBe(true);
        expect(requiresBrowserDescription('screenshot')).toBe(true);
        expect(normalizeBrowserDescription('  查看 GitHub 发布页  ')).toBe('查看 GitHub 发布页');
        expect(normalizeBrowserDescription('   ')).toBeNull();
    });

    it('prioritizes blocked domains over allowed domains and action defaults', () => {
        const config = {
            ...DEFAULT_BROWSER_SETTINGS,
            permissions: {
                ...DEFAULT_BROWSER_SETTINGS.permissions,
                navigate: 'ask' as const,
            },
            blockedDomains: [{ domain: 'example.com' }],
            allowedDomains: [{ domain: 'docs.example.com' }],
        };

        expect(
            evaluateBrowserPermission(config, 'navigate', {
                url: 'https://docs.example.com/release-notes',
            })
        ).toMatchObject({ decision: 'deny' });
    });

    it('allows configured domains when the action would otherwise ask', () => {
        const config = {
            ...DEFAULT_BROWSER_SETTINGS,
            permissions: {
                ...DEFAULT_BROWSER_SETTINGS.permissions,
                navigate: 'ask' as const,
            },
            allowedDomains: [{ domain: 'github.com' }],
        };

        expect(
            evaluateBrowserPermission(config, 'navigate', {
                url: 'https://github.com/TouchAI-org/TouchAI/releases',
            })
        ).toMatchObject({ decision: 'allow' });
    });

    it('falls back to the operation permission for unknown domains', () => {
        const config = {
            ...DEFAULT_BROWSER_SETTINGS,
            permissions: {
                ...DEFAULT_BROWSER_SETTINGS.permissions,
                navigate: 'deny' as const,
            },
            allowedDomains: [{ domain: 'github.com' }],
        };

        expect(
            evaluateBrowserPermission(config, 'navigate', {
                url: 'https://example.net',
            })
        ).toMatchObject({ decision: 'deny' });
    });

    it('requires user selection when multiple existing sessions are available', () => {
        const config = {
            ...DEFAULT_BROWSER_SETTINGS,
            permissionMode: 'allow' as const,
            existingSessionPolicy: 'auto' as const,
            permissions: {
                ...DEFAULT_BROWSER_SETTINGS.permissions,
                connectExisting: 'allow' as const,
            },
        };

        expect(
            evaluateBrowserPermission(config, 'connect_existing', {
                availableSessionCount: 2,
            })
        ).toMatchObject({ decision: 'ask' });
    });

    it('allows all operations in global allow mode while still honoring blocked domains', () => {
        const config = {
            ...DEFAULT_BROWSER_SETTINGS,
            permissionMode: 'allow' as const,
            permissions: {
                ...DEFAULT_BROWSER_SETTINGS.permissions,
                navigate: 'deny' as const,
                click: 'deny' as const,
            },
            blockedDomains: [{ domain: 'blocked.example' }],
        };

        expect(
            evaluateBrowserPermission(config, 'click', {
                url: 'https://example.test',
            })
        ).toMatchObject({ decision: 'allow', reason: 'permission-mode-allow' });
        expect(
            evaluateBrowserPermission(config, 'navigate', {
                url: 'https://blocked.example',
            })
        ).toMatchObject({ decision: 'deny', reason: 'domain-blocked' });
    });

    it('denies browser operations in global deny mode after domain/session safety checks', () => {
        const config = {
            ...DEFAULT_BROWSER_SETTINGS,
            permissionMode: 'deny' as const,
            permissions: {
                ...DEFAULT_BROWSER_SETTINGS.permissions,
                navigate: 'allow' as const,
            },
        };

        expect(
            evaluateBrowserPermission(config, 'navigate', {
                url: 'https://example.test',
            })
        ).toMatchObject({ decision: 'deny', reason: 'permission-mode-deny' });
    });
});
