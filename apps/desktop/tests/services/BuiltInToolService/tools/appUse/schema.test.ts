import { describe, expect, it } from 'vitest';

import {
    appUseActArgsSchema,
    appUseObserveArgsSchema,
    appUseSessionArgsSchema,
} from '@/services/BuiltInToolService/tools/appUse';

describe('App Use tool schemas', () => {
    it('requires a user-facing description for every model-facing tool', () => {
        expect(appUseSessionArgsSchema.safeParse({ operation: 'discover' }).success).toBe(false);
        expect(
            appUseObserveArgsSchema.safeParse({
                adapterId: 'wps_writer',
                scope: 'selection',
            }).success
        ).toBe(false);
        expect(
            appUseActArgsSchema.safeParse({
                adapterId: 'wps_writer',
                action: 'replace_selection',
            }).success
        ).toBe(false);
    });

    it('accepts first-batch adapters and structured operation scopes', () => {
        expect(
            appUseSessionArgsSchema.parse({
                operation: 'discover',
                description: '列出可用软件',
            })
        ).toEqual({ operation: 'discover', description: '列出可用软件' });

        expect(
            appUseObserveArgsSchema.parse({
                adapterId: 'photoshop',
                scope: 'layers',
                description: '读取当前图层列表',
            })
        ).toEqual({
            adapterId: 'photoshop',
            scope: 'layers',
            description: '读取当前图层列表',
        });
    });

    it('rejects raw automation payloads even when hidden under common field names', () => {
        for (const hiddenField of ['script', 'rawScript', 'macro', 'vba', 'batchPlay']) {
            const result = appUseActArgsSchema.safeParse({
                adapterId: 'wps_writer',
                action: 'replace_selection',
                description: '替换当前选区文本',
                [hiddenField]: 'dangerous()',
            });

            expect(result.success).toBe(false);
        }
    });

    it('keeps each app action bounded to exactly one requested action', () => {
        expect(
            appUseActArgsSchema.safeParse({
                adapterId: 'office_word',
                action: 'replace_selection',
                actions: ['replace_selection', 'save_as'],
                description: '替换选区并另存为',
            }).success
        ).toBe(false);
    });
});
