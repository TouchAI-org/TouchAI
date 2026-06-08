import { describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import { builtInToolRegistry } from '@/services/BuiltInToolService/registry';

describe('App Use built-in tool registration', () => {
    it('registers the three model-facing App Use tools', () => {
        expect(builtInToolRegistry.get('app_session')?.displayName).toBe('AppSession');
        expect(builtInToolRegistry.get('app_observe')?.displayName).toBe('AppObserve');
        expect(builtInToolRegistry.get('app_act')?.displayName).toBe('AppAct');
    });

    it('keeps App Use tool schemas model-facing and English-only', () => {
        for (const toolId of ['app_session', 'app_observe', 'app_act']) {
            const descriptor = builtInToolRegistry.get(toolId);
            expect(descriptor?.description).toContain('App Use');
            expect(JSON.stringify(descriptor?.inputSchema)).not.toMatch(/\p{Script=Han}/u);
        }
    });

    it('localizes action approval copy through i18n keys', async () => {
        setLocale('en-US');
        const tool = builtInToolRegistry.get('app_act');

        const approval = await Promise.resolve(
            tool?.buildApprovalRequest(
                {
                    adapterId: 'wps_writer',
                    action: 'replace_selection',
                    description: 'Replace text in an owned WPS document',
                    targetId: 'owned-document-1',
                    parameters: { text: 'replacement preview' },
                },
                tool.defaultConfig,
                'builtin__app_act',
                {
                    callId: 'call-1',
                    iteration: 1,
                    hasExecutedBuiltInTool: () => false,
                }
            )
        );

        expect(approval).toMatchObject({
            title: 'App Use confirmation',
            riskLabel: 'High risk',
            reason: 'App Use actions may modify local application or document state and require user confirmation.',
            commandLabel: 'Action',
            approveLabel: 'Approve',
            rejectLabel: 'Reject',
        });
        expect(approval?.description).toContain('Replace text in an owned WPS document');
        expect(approval?.description).toContain('Target: owned-document-1');
        expect(approval?.description).toContain('Preview: replacement preview');
        expect(approval?.command).toBe('wps_writer:replace_selection -> owned-document-1');
    });

    it('omits action approval preview when parameters are absent or not serializable', async () => {
        setLocale('en-US');
        const tool = builtInToolRegistry.get('app_act');

        const noParametersApproval = await Promise.resolve(
            tool?.buildApprovalRequest(
                {
                    adapterId: 'wps_writer',
                    action: 'replace_selection',
                    description: 'Replace without preview',
                },
                tool.defaultConfig,
                'builtin__app_act',
                {
                    callId: 'call-2',
                    iteration: 1,
                    hasExecutedBuiltInTool: () => false,
                }
            )
        );
        const unserializableApproval = await Promise.resolve(
            tool?.buildApprovalRequest(
                {
                    adapterId: 'wps_writer',
                    action: 'replace_selection',
                    description: 'Replace with unserializable preview',
                    parameters: { value: 1n },
                },
                tool.defaultConfig,
                'builtin__app_act',
                {
                    callId: 'call-3',
                    iteration: 1,
                    hasExecutedBuiltInTool: () => false,
                }
            )
        );

        expect(noParametersApproval?.description).not.toContain('Preview:');
        expect(unserializableApproval?.description).not.toContain('Preview:');
    });

    it('renders non-text action parameters as a compact JSON preview', async () => {
        setLocale('en-US');
        const tool = builtInToolRegistry.get('app_act');

        const approval = await Promise.resolve(
            tool?.buildApprovalRequest(
                {
                    adapterId: 'wps_spreadsheet',
                    action: 'write_cells',
                    description: 'Write spreadsheet cells',
                    parameters: {
                        range: 'A1:B1',
                        values: [
                            ['Name', 'Status'],
                            ['App Use', 'Ready'],
                        ],
                    },
                },
                tool.defaultConfig,
                'builtin__app_act',
                {
                    callId: 'call-4',
                    iteration: 1,
                    hasExecutedBuiltInTool: () => false,
                }
            )
        );

        expect(approval?.description).toContain(
            'Preview: {"range":"A1:B1","values":[["Name","Status"],["App Use","Ready"]]}'
        );
    });
});
