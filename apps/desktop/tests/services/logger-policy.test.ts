import { describe, expect, it } from 'vitest';

import {
    createDiagnosticLoggerConfig,
    DEFAULT_LOGGER_CONFIG,
    inferCategoryFromArgs,
    LOG_LEVEL_VALUES,
    normalizeLogFields,
    resolveLogThreshold,
    shouldForwardLog,
} from '@/services/LoggerService/policy';

describe('LoggerService policy', () => {
    it('keeps release-default forwarding at warn/error for noisy categories', () => {
        expect(
            shouldForwardLog({
                level: 'info',
                category: 'resize',
                config: DEFAULT_LOGGER_CONFIG,
            })
        ).toBe(false);

        expect(
            shouldForwardLog({
                level: 'warn',
                category: 'resize',
                config: DEFAULT_LOGGER_CONFIG,
            })
        ).toBe(true);
    });

    it('allows diagnostic mode to forward debug resize and performance events', () => {
        const config = createDiagnosticLoggerConfig();

        expect(resolveLogThreshold('resize', config)).toBe(LOG_LEVEL_VALUES.debug);
        expect(
            shouldForwardLog({
                level: 'debug',
                category: 'performance',
                config,
            })
        ).toBe(true);
    });

    it('infers categories from existing hard-coded prefixes during migration', () => {
        expect(inferCategoryFromArgs(['[SearchView] Failed to resize', new Error('boom')])).toBe(
            'search'
        );
        expect(inferCategoryFromArgs(['[McpManager] Starting auto-connect...'])).toBe('mcp');
        expect(inferCategoryFromArgs(['plain message'])).toBe('unknown');
    });

    it('normalizes structured fields to small strings and drops sensitive or oversized values', () => {
        expect(
            normalizeLogFields({
                category: 'resize',
                targetHeight: 420,
                password: 'secret',
                prompt: 'do not log prompt text',
                large: 'x'.repeat(260),
                ok: true,
            })
        ).toEqual({
            category: 'resize',
            targetHeight: '420',
            large: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
            ok: 'true',
        });
    });
});
