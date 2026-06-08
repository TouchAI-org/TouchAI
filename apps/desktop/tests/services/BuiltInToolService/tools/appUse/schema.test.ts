import { describe, expect, it } from 'vitest';

import {
    APP_ACT_TOOL_INPUT_SCHEMA,
    APP_OBSERVE_TOOL_INPUT_SCHEMA,
    APP_SESSION_TOOL_INPUT_SCHEMA,
    appUseActArgsSchema,
    appUseObserveArgsSchema,
    appUseSessionArgsSchema,
} from '@/services/BuiltInToolService/tools/appUse';

describe('App Use tool schemas', () => {
    function expectRawAutomationRejection(
        result: ReturnType<typeof appUseActArgsSchema.safeParse>
    ) {
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(
                result.error.issues.some((issue) => issue.message.includes('Raw automation'))
            ).toBe(true);
        }
    }

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
                action: 'replace_document_text',
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
            appUseSessionArgsSchema.parse({
                operation: 'create_owned_target',
                description: 'create owned spreadsheet target',
                adapterId: 'wps_spreadsheet',
                targetKind: 'spreadsheet',
            })
        ).toEqual({
            operation: 'create_owned_target',
            description: 'create owned spreadsheet target',
            adapterId: 'wps_spreadsheet',
            targetKind: 'spreadsheet',
        });

        expect(
            appUseSessionArgsSchema.safeParse({
                operation: 'create_owned_target',
                description: 'create owned target without adapter',
            }).success
        ).toBe(false);

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
                adapterId: 'wps_spreadsheet',
                action: 'write_cells',
                description: '替换当前选区文本',
                targetId: 'owned-spreadsheet-1',
                parameters: {
                    range: 'A1:B1',
                    values: [['safe']],
                    [hiddenField]: 'dangerous()',
                },
            });

            expectRawAutomationRejection(result);
        }

        expect(
            appUseActArgsSchema.safeParse({
                adapterId: 'wps_spreadsheet',
                action: 'write_cells',
                description: 'write selected cells',
                targetId: 'owned-spreadsheet-1',
                parameters: {
                    range: 'A1:B1',
                    values: [['safe']],
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
                action: 'replace_document_text',
                actions: ['replace_document_text', 'save_as'],
                description: '替换选区并另存为',
                targetId: 'owned-document-1',
            }).success
        ).toBe(false);
    });

    it('does not expose unsupported Writer insert or Adobe actions to models', () => {
        const actionSchema = APP_ACT_TOOL_INPUT_SCHEMA.properties.action as {
            enum: string[];
            description: string;
        };
        const sessionOperationSchema = APP_SESSION_TOOL_INPUT_SCHEMA.properties.operation as {
            enum: string[];
            description: string;
        };
        const adapterSchema = APP_ACT_TOOL_INPUT_SCHEMA.properties.adapterId as { enum: string[] };
        const parameterSchema = APP_ACT_TOOL_INPUT_SCHEMA.properties.parameters as {
            description: string;
        };

        expect(APP_ACT_TOOL_INPUT_SCHEMA.required).toContain('parameters');
        expect(APP_ACT_TOOL_INPUT_SCHEMA.required).toContain('targetId');
        expect(sessionOperationSchema.enum).toContain('create_owned_target');
        expect(sessionOperationSchema.description).toContain('TouchAI-owned signed target path');
        expect(actionSchema.enum).not.toContain('replace_selection');
        expect(actionSchema.enum).not.toContain('format_selection');
        expect(actionSchema.enum).not.toContain('insert_text');
        expect(actionSchema.enum).not.toContain('select_layer');
        expect(actionSchema.enum).not.toContain('export_preview');
        expect(actionSchema.enum).not.toContain('batch_export');
        expect(actionSchema.enum).not.toContain('cross_app_transfer');
        expect(actionSchema.description).not.toContain('insert_text');
        expect(parameterSchema.description).not.toContain('select_layer');
        expect(parameterSchema.description).not.toContain('export_preview');
        expect(adapterSchema.enum).not.toContain('photoshop');
        expect(adapterSchema.enum).not.toContain('illustrator');

        expect(
            appUseActArgsSchema.safeParse({
                adapterId: 'wps_writer',
                action: 'insert_text',
                description: 'insert text at the cursor',
                targetId: 'owned-document-1',
                parameters: { text: 'hello' },
            }).success
        ).toBe(false);
        expect(
            appUseActArgsSchema.safeParse({
                adapterId: 'photoshop',
                action: 'export_preview',
                description: 'export a preview',
            }).success
        ).toBe(false);
    });

    it('describes targetId as a TouchAI-owned signed target path', () => {
        const observeTargetSchema = APP_OBSERVE_TOOL_INPUT_SCHEMA.properties.targetId as {
            description: string;
        };
        const actTargetSchema = APP_ACT_TOOL_INPUT_SCHEMA.properties.targetId as {
            description: string;
        };

        expect(observeTargetSchema.description).toContain('TouchAI-owned signed target path');
        expect(actTargetSchema.description).toContain('TouchAI-owned signed target path');
        expect(actTargetSchema.description).toContain('not an arbitrary local path');
        expect(actTargetSchema.description).not.toContain('returned by app_session');
    });

    it('rejects actions for adapters that do not implement them', () => {
        expect(
            appUseActArgsSchema.safeParse({
                adapterId: 'wps_writer',
                action: 'write_cells',
                description: 'write cells from a writer adapter',
                targetId: 'owned-document-1',
                parameters: { range: 'A1:B1', values: [['Name', 'Status']] },
            }).success
        ).toBe(false);
        expect(
            appUseActArgsSchema.safeParse({
                adapterId: 'wps_spreadsheet',
                action: 'replace_document_text',
                description: 'replace text from a spreadsheet adapter',
                targetId: 'owned-spreadsheet-1',
                parameters: { text: 'hello' },
            }).success
        ).toBe(false);
    });

    it('validates structured parameters for supported write actions', () => {
        expect(
            appUseActArgsSchema.safeParse({
                adapterId: 'wps_writer',
                action: 'format_document_text',
                description: 'format owned document',
                targetId: 'owned-document-1',
                parameters: {},
            }).success
        ).toBe(false);
        expect(
            appUseActArgsSchema.safeParse({
                adapterId: 'wps_spreadsheet',
                action: 'write_cells',
                description: 'write owned sheet',
                targetId: 'owned-spreadsheet-1',
                parameters: { range: 'A1:B1', values: [] },
            }).success
        ).toBe(false);
        expect(
            appUseActArgsSchema.safeParse({
                adapterId: 'wps_presentation',
                action: 'add_slide_text',
                description: 'add text to owned slide',
                targetId: 'owned-presentation-1',
                parameters: { text: ' ' },
            }).success
        ).toBe(false);
        expect(
            appUseActArgsSchema.safeParse({
                adapterId: 'wps_writer',
                action: 'replace_document_text',
                description: 'replace owned document',
                targetId: 'owned-document-1',
                parameters: { text: 'x'.repeat(20_001) },
            }).success
        ).toBe(false);

        expect(
            appUseActArgsSchema.safeParse({
                adapterId: 'wps_writer',
                action: 'format_document_text',
                description: 'format owned document',
                targetId: 'owned-document-1',
                parameters: { bold: true, fontSize: 18, fontName: 'Arial' },
            }).success
        ).toBe(true);
        expect(
            appUseActArgsSchema.safeParse({
                adapterId: 'wps_spreadsheet',
                action: 'write_cells',
                description: 'write owned sheet',
                targetId: 'owned-spreadsheet-1',
                parameters: { range: 'A1:B1', values: [['Name', 'Status']] },
            }).success
        ).toBe(true);
        expect(
            appUseActArgsSchema.safeParse({
                adapterId: 'wps_presentation',
                action: 'add_slide_text',
                description: 'add text to owned slide',
                targetId: 'owned-presentation-1',
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
                targetId: 'owned-presentation-1',
                parameters: { text: '   hello slide   ', slideIndex: 1 },
            }).parameters
        ).toEqual({ text: 'hello slide', slideIndex: 1 });
    });

    it('uses app_observe, not app_act, for structured read-only cell access', () => {
        expect(
            appUseObserveArgsSchema.safeParse({
                adapterId: 'wps_spreadsheet',
                scope: 'worksheet',
                description: 'read cells',
            }).success
        ).toBe(true);
    });

    it('validates parameter shapes for supported actions without allowing arbitrary objects', () => {
        expect(
            appUseActArgsSchema.safeParse({
                adapterId: 'wps_spreadsheet',
                action: 'write_cells',
                description: 'write cells with raw code',
                targetId: 'owned-spreadsheet-1',
                parameters: { range: 'A1:B1', values: [['safe']], rawScript: 'dangerous()' },
            }).success
        ).toBe(false);
    });
});
