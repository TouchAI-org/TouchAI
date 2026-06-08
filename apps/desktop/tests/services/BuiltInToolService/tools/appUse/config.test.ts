import { describe, expect, it } from 'vitest';

import {
    APP_USE_ADAPTER_IDS,
    DEFAULT_APP_USE_TOOL_CONFIG,
    parseAppUseToolConfig,
    serializeAppUseToolConfig,
} from '@/services/BuiltInToolService/tools/appUse';

describe('App Use tool config', () => {
    it('defaults to read-only with every first-batch adapter disabled', () => {
        expect(parseAppUseToolConfig(null)).toEqual(DEFAULT_APP_USE_TOOL_CONFIG);
        expect(DEFAULT_APP_USE_TOOL_CONFIG.mode).toBe('read_only');
        expect(DEFAULT_APP_USE_TOOL_CONFIG.mutatingApprovalMode).toBe('always');
        expect(DEFAULT_APP_USE_TOOL_CONFIG.allowRawAutomation).toBe(false);
        expect(Object.keys(DEFAULT_APP_USE_TOOL_CONFIG.adapters).sort()).toEqual(
            [...APP_USE_ADAPTER_IDS].sort()
        );
        expect(
            Object.values(DEFAULT_APP_USE_TOOL_CONFIG.adapters).every((enabled) => !enabled)
        ).toBe(true);
    });

    it('normalizes known adapters and ignores unknown adapter ids', () => {
        const parsed = parseAppUseToolConfig(
            JSON.stringify({
                mode: 'interactive',
                adapters: {
                    wps_writer: true,
                    office_word: true,
                    unknown_app: true,
                },
            })
        );

        expect(parsed.mode).toBe('interactive');
        expect(parsed.adapters.wps_writer).toBe(true);
        expect(parsed.adapters.office_word).toBe(true);
        expect(Object.keys(parsed.adapters)).not.toContain('unknown_app');
    });

    it('keeps unsafe or invalid config values inside conservative limits', () => {
        const parsed = parseAppUseToolConfig(
            JSON.stringify({
                mode: 'full_auto',
                mutatingApprovalMode: 'never',
                readScope: 'entire_machine',
                allowBackgroundOperation: true,
                allowRawAutomation: true,
                timeoutMs: 250,
                maxOutputChars: 500000,
            })
        );

        expect(parsed.mode).toBe(DEFAULT_APP_USE_TOOL_CONFIG.mode);
        expect(parsed.mutatingApprovalMode).toBe('always');
        expect(parsed.readScope).toBe(DEFAULT_APP_USE_TOOL_CONFIG.readScope);
        expect(parsed.allowRawAutomation).toBe(false);
        expect(parsed.timeoutMs).toBe(DEFAULT_APP_USE_TOOL_CONFIG.timeoutMs);
        expect(parsed.maxOutputChars).toBe(DEFAULT_APP_USE_TOOL_CONFIG.maxOutputChars);
        expect(parsed).not.toHaveProperty('allowBackgroundOperation');
        expect(JSON.parse(serializeAppUseToolConfig(parsed))).not.toHaveProperty(
            'allowBackgroundOperation'
        );
    });

    it('ignores legacy advanced workflow switches and does not persist them', () => {
        const parsed = parseAppUseToolConfig(
            JSON.stringify({
                advanced: {
                    exportPreviews: true,
                    batchWorkflows: 'yes',
                    crossAppWorkflows: true,
                    unknown: true,
                },
                allowRawAutomation: true,
            })
        );

        expect(parsed.allowRawAutomation).toBe(false);
        expect(parsed).not.toHaveProperty('advanced');
        expect(JSON.parse(serializeAppUseToolConfig(parsed))).not.toHaveProperty('advanced');
    });
});
