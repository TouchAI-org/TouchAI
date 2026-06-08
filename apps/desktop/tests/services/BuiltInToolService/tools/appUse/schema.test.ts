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

        expect(
            appUseActArgsSchema.safeParse({
                adapterId: 'illustrator',
                action: 'batch_export',
                description: 'export selected artboards',
                parameters: {
                    format: 'png',
                    nested: {
                        uxp: { rawScript: 'dangerous()' },
                    },
                },
            }).success
        ).toBe(false);
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

    it('validates structured parameters for supported write actions', () => {
        expect(
            appUseActArgsSchema.safeParse({
                adapterId: 'wps_writer',
                action: 'format_selection',
                description: 'format owned document',
                parameters: {},
            }).success
        ).toBe(false);
        expect(
            appUseActArgsSchema.safeParse({
                adapterId: 'wps_spreadsheet',
                action: 'write_cells',
                description: 'write owned sheet',
                parameters: { range: 'A1:B1', values: [] },
            }).success
        ).toBe(false);
        expect(
            appUseActArgsSchema.safeParse({
                adapterId: 'wps_presentation',
                action: 'add_slide_text',
                description: 'add text to owned slide',
                parameters: { text: ' ' },
            }).success
        ).toBe(false);

        expect(
            appUseActArgsSchema.safeParse({
                adapterId: 'wps_writer',
                action: 'format_selection',
                description: 'format owned document',
                parameters: { bold: true, fontSize: 18, fontName: 'Arial' },
            }).success
        ).toBe(true);
        expect(
            appUseActArgsSchema.safeParse({
                adapterId: 'wps_spreadsheet',
                action: 'write_cells',
                description: 'write owned sheet',
                parameters: { range: 'A1:B1', values: [['Name', 'Status']] },
            }).success
        ).toBe(true);
        expect(
            appUseActArgsSchema.safeParse({
                adapterId: 'wps_presentation',
                action: 'add_slide_text',
                description: 'add text to owned slide',
                parameters: { text: 'hello slide', slideIndex: 1 },
            }).success
        ).toBe(true);
    });

    it('returns normalized action parameters after parsing', () => {
        expect(
            appUseActArgsSchema.parse({
                adapterId: 'wps_presentation',
                action: 'add_slide_text',
                description: 'add text to owned slide',
                parameters: { text: '   hello slide   ', slideIndex: 1 },
            }).parameters
        ).toEqual({ text: 'hello slide', slideIndex: 1 });

        expect(
            appUseActArgsSchema.parse({
                adapterId: 'photoshop',
                action: 'select_layer',
                description: 'select a layer',
                parameters: { layerName: '   Logo   ' },
            }).parameters
        ).toEqual({ layerName: 'Logo' });
    });

    it('validates parameter shapes for planned actions without allowing arbitrary objects', () => {
        expect(
            appUseActArgsSchema.safeParse({
                adapterId: 'wps_spreadsheet',
                action: 'read_cells',
                description: 'read cells',
                parameters: { range: 'A1:B2' },
            }).success
        ).toBe(true);
        expect(
            appUseActArgsSchema.safeParse({
                adapterId: 'photoshop',
                action: 'select_layer',
                description: 'select a layer',
                parameters: { layerName: 'Logo' },
            }).success
        ).toBe(true);
        expect(
            appUseActArgsSchema.safeParse({
                adapterId: 'photoshop',
                action: 'export_preview',
                description: 'export preview',
                parameters: { format: 'png', selectionOnly: true },
            }).success
        ).toBe(true);
        expect(
            appUseActArgsSchema.safeParse({
                adapterId: 'illustrator',
                action: 'cross_app_transfer',
                description: 'transfer selected text',
                parameters: {
                    sourceAdapterId: 'illustrator',
                    targetAdapterId: 'wps_writer',
                    mode: 'copy_text',
                },
            }).success
        ).toBe(true);

        expect(
            appUseActArgsSchema.safeParse({
                adapterId: 'photoshop',
                action: 'select_layer',
                description: 'select no layer',
                parameters: {},
            }).success
        ).toBe(false);
        expect(
            appUseActArgsSchema.safeParse({
                adapterId: 'photoshop',
                action: 'export_preview',
                description: 'export preview with raw code',
                parameters: { format: 'png', command: 'raw()', rawScript: 'dangerous()' },
            }).success
        ).toBe(false);
    });
});
