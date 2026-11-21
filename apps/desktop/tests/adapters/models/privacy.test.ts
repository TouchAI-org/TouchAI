import { webcrypto } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const privacyModel = vi.hoisted(() => ({
    getModelStatus: vi.fn(),
    detect: vi.fn(),
    recordProtection: vi.fn(),
}));

import { mockTauriCommand } from '@tests/utils/tauri';
import { buildModelMessages } from '@touchai/models';

import type { DesktopModelMessage as AiMessage } from '@/adapters/models/input';
import { maskDesktopModelMessages as maskAiMessages } from '@/adapters/models/privacy';
import { prepareModelRequest } from '@/adapters/models/transport';
import { recordPrivacyProtection } from '@/modules/privacy';
import {
    DEFAULT_PRIVACY_FILTER_SETTINGS,
    type PrivacyFilterSettings,
} from '@/modules/privacy/public';

describe('given a user sends a prompt with privacy filtering enabled', () => {
    beforeEach(() => {
        vi.stubGlobal('crypto', webcrypto);
        mockTauriCommand('privacy_filter_model_status', (payload) =>
            privacyModel.getModelStatus((payload as { modelId: string }).modelId)
        );
        mockTauriCommand('privacy_filter_detect', (payload) => {
            const { texts, modelId } = payload as { texts: string[]; modelId: string };
            return privacyModel.detect(texts, modelId);
        });
        mockTauriCommand('privacy_filter_record_protection', (payload) => {
            const { record, details } = payload as { record: unknown; details: unknown };
            return privacyModel.recordProtection(record, details);
        });
        privacyModel.getModelStatus.mockReset();
        privacyModel.getModelStatus.mockResolvedValue({ installed: false });
        privacyModel.detect.mockReset();
        privacyModel.recordProtection.mockReset().mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('user masks identified user text then review retains the exact accepted positions and actual rule without copying the whole message', async () => {
        const text = '请联系 ada@example.test。';
        const result = await maskAiMessages(
            [
                {
                    role: 'user',
                    content: text,
                    contextSource: { id: 41, fingerprint: 'a'.repeat(64) },
                },
            ],
            {
                ...DEFAULT_PRIVACY_FILTER_SETTINGS,
                enabled: true,
                useLocalModel: false,
            }
        );
        expect(result.annotations).toEqual([
            {
                messageId: 41,
                textHash: expect.stringMatching(/^[0-9a-f]{64}$/),
                start: text.indexOf('ada@example.test'),
                end: text.indexOf('ada@example.test') + 'ada@example.test'.length,
                original: 'ada@example.test',
                placeholder: expect.stringMatching(/^\{\{EMAIL_[0-9a-f]{16}\}\}$/),
                kind: 'email',
                rule: { id: 'email' },
            },
        ]);
        expect(JSON.stringify(result.annotations)).not.toContain('请联系');
    });

    it('user masks unidentified or non-user text then no historical message is guessed for review', async () => {
        const settings = {
            ...DEFAULT_PRIVACY_FILTER_SETTINGS,
            enabled: true,
            useLocalModel: false,
        };
        const unidentified = await maskAiMessages(
            [{ role: 'user', content: 'ada@example.test' }],
            settings
        );
        const assistant = await maskAiMessages(
            [
                {
                    role: 'assistant',
                    content: 'ada@example.test',
                    contextSource: { id: 41, fingerprint: 'a'.repeat(64) },
                },
            ],
            settings
        );
        expect(unidentified.annotations).toEqual([]);
        expect(assistant.annotations).toEqual([]);
    });

    it.each([
        {
            label: 'private key',
            id: 'privateKey',
            category: 'secrets',
            text: [
                ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
                'x'.repeat(32),
                ['-----END', 'PRIVATE KEY-----'].join(' '),
            ].join('\n'),
        },
        {
            label: 'API key',
            id: 'apiKey',
            category: 'secrets',
            text: ['sk', 'x'.repeat(32)].join('-'),
        },
        {
            label: 'JWT',
            id: 'jwt',
            category: 'secrets',
            text: ['eyJ' + 'a'.repeat(12), 'b'.repeat(12), 'c'.repeat(12)].join('.'),
        },
        {
            label: 'secret assignment',
            id: 'secretAssignment',
            category: 'secrets',
            text: ['DB_PASSWORD', ['demo', 'password'].join('_')].join('='),
        },
        {
            label: 'URL password',
            id: 'urlPassword',
            category: 'secrets',
            text: ['https://demo:', ['demo', 'password'].join('_'), '@example.test'].join(''),
        },
        { label: 'email', id: 'email', category: 'email', text: 'ada@example.test' },
        { label: 'phone', id: 'phone', category: 'phone', text: ['138', '0013', '8000'].join('') },
        {
            label: 'identity number',
            id: 'chinaId',
            category: 'account',
            text: ['110105', '19491231', '002X'].join(''),
        },
        {
            label: 'payment card',
            id: 'paymentCard',
            category: 'paymentCard',
            text: ['4111', '1111', '1111', '1111'].join(''),
        },
    ])(
        'user masks a $label then its actual matching rule is available with the replacement',
        async ({ id, category, text }) => {
            const categories = Object.fromEntries(
                Object.keys(DEFAULT_PRIVACY_FILTER_SETTINGS.categories).map((key) => [
                    key,
                    key === category,
                ])
            ) as PrivacyFilterSettings['categories'];
            const result = await maskAiMessages(
                [
                    {
                        role: 'user',
                        content: text,
                        contextSource: { id: 41, fingerprint: 'a'.repeat(64) },
                    },
                ],
                {
                    ...DEFAULT_PRIVACY_FILTER_SETTINGS,
                    enabled: true,
                    useLocalModel: false,
                    categories,
                }
            );
            expect(result.annotations).toHaveLength(1);
            expect(result.annotations[0]?.rule).toEqual({ id });
            expect(result.annotations[0]?.original).toBe(
                text.slice(result.annotations[0]!.start, result.annotations[0]!.end)
            );
            expect(result.session.restoreText(String(result.messages[0]?.content))).toBe(text);
            expect(JSON.stringify(result.session.protectionSummary())).not.toContain('matches');
        }
    );

    it('user masks a custom word and prefix then sees the exact configured rule values that caused the replacements', async () => {
        const prefix = 'company_token_';
        const word = 'Project Nightfall';
        const result = await maskAiMessages(
            [
                {
                    role: 'user',
                    content: `${prefix}ABCDEF ${word}`,
                    contextSource: { id: 41, fingerprint: 'a'.repeat(64) },
                },
            ],
            {
                ...DEFAULT_PRIVACY_FILTER_SETTINGS,
                enabled: true,
                useLocalModel: false,
                categories: { ...DEFAULT_PRIVACY_FILTER_SETTINGS.categories, secrets: true },
                secretPrefixes: [prefix],
                maskedWords: [word],
            }
        );
        expect(result.annotations.map((annotation) => annotation.rule)).toEqual([
            { id: 'customPrefix', value: prefix },
            { id: 'customWord', value: word },
        ]);
    });

    it('user selects the local model then their own words and prefixes still mask without depending on model categories', async () => {
        const prefix = 'company_token_';
        const word = 'Project Nightfall';
        privacyModel.getModelStatus.mockResolvedValue({ installed: true });
        privacyModel.detect.mockResolvedValue([[]]);
        const result = await maskAiMessages(
            [
                {
                    role: 'user',
                    content: `${prefix}ABCDEF ${word}`,
                    contextSource: { id: 41, fingerprint: 'a'.repeat(64) },
                },
            ],
            {
                ...DEFAULT_PRIVACY_FILTER_SETTINGS,
                enabled: true,
                useLocalModel: true,
                categories: { ...DEFAULT_PRIVACY_FILTER_SETTINGS.categories, secrets: false },
                secretPrefixes: [prefix],
                maskedWords: [word],
            }
        );
        expect(result.annotations.map((annotation) => annotation.rule)).toEqual([
            { id: 'customPrefix', value: prefix },
            { id: 'customWord', value: word },
        ]);
    });

    it('user selects a local model then a name detected by that model retains its actual detector rather than a guessed rule', async () => {
        const name = ['Morgan', 'Lee'].join(' ');
        privacyModel.getModelStatus.mockResolvedValue({ installed: true });
        privacyModel.detect.mockResolvedValue([
            [{ start: 0, end: name.length, kind: 'private_person', score: 0.95 }],
        ]);
        const result = await maskAiMessages(
            [
                {
                    role: 'user',
                    content: name,
                    contextSource: { id: 41, fingerprint: 'a'.repeat(64) },
                },
            ],
            {
                ...DEFAULT_PRIVACY_FILTER_SETTINGS,
                enabled: true,
                categories: { ...DEFAULT_PRIVACY_FILTER_SETTINGS.categories, privatePerson: true },
            },
            'openmed-privacy-filter'
        );
        expect(result.annotations[0]?.rule).toEqual({
            id: 'localModel',
            modelId: 'openmed-privacy-filter',
        });
    });

    it('user has an email detected by both a rule and a model then only the accepted replacement source is reported', async () => {
        const email = 'ada@example.test';
        privacyModel.getModelStatus.mockResolvedValue({ installed: true });
        privacyModel.detect.mockResolvedValue([
            [{ start: 0, end: email.length, kind: 'email', score: 0.95 }],
        ]);
        const settings = {
            ...DEFAULT_PRIVACY_FILTER_SETTINGS,
            enabled: true,
            categories: { ...DEFAULT_PRIVACY_FILTER_SETTINGS.categories, email: true },
        };
        const result = await maskAiMessages(
            [
                {
                    role: 'user',
                    content: email,
                    contextSource: { id: 41, fingerprint: 'a'.repeat(64) },
                },
            ],
            settings
        );
        expect(result.annotations[0]?.rule).toEqual({ id: 'email' });
        const excluded = await maskAiMessages([{ role: 'user', content: email }], {
            ...settings,
            neverMask: [email],
        });
        expect(excluded.annotations).toEqual([]);
    });

    it('user keeps credentials out of the provider prompt and restores them locally when using algorithmic rules', async () => {
        const secret = 'sk-test12345678901234567890';
        const sourceMessages = [{ role: 'user' as const, content: `Use this key: ${secret}` }];
        const settings = {
            ...DEFAULT_PRIVACY_FILTER_SETTINGS,
            enabled: true,
            useLocalModel: false,
            categories: { ...DEFAULT_PRIVACY_FILTER_SETTINGS.categories, secrets: true },
        };

        const result = await maskAiMessages(sourceMessages, settings);
        const outgoingContent = String(result.messages[0]?.content);

        expect(outgoingContent).not.toContain(secret);
        expect(outgoingContent).toMatch(/\{\{API_KEY_[0-9a-f]{16}\}\}/);
        expect(result.session.restoreText(String(outgoingContent))).toContain(secret);
        expect(sourceMessages[0]?.content).toContain(secret);
        expect(privacyModel.detect).not.toHaveBeenCalled();
    });

    it('user sees only selected email addresses masked when an exclusion is configured', async () => {
        const privateAddress = 'ada@example.test';
        const excludedAddress = 'team@example.test';
        const sourceMessages = [
            {
                role: 'user' as const,
                content: `Contact ${privateAddress}, not ${excludedAddress}.`,
            },
        ];
        const settings: PrivacyFilterSettings = {
            ...DEFAULT_PRIVACY_FILTER_SETTINGS,
            enabled: true,
            useLocalModel: false,
            categories: {
                ...DEFAULT_PRIVACY_FILTER_SETTINGS.categories,
                secrets: false,
                email: true,
            },
            neverMask: [excludedAddress],
        };

        const result = await maskAiMessages(sourceMessages, settings);
        const outgoingContent = String(result.messages[0]?.content);

        expect(outgoingContent).not.toContain(privateAddress);
        expect(outgoingContent).toContain(excludedAddress);
    });

    it('user keeps custom terms out of the prompt when only word rules are enabled', async () => {
        const customTerm = 'Project Nightfall';
        const text = `The client code is ${customTerm}.`;
        const settings: PrivacyFilterSettings = {
            ...DEFAULT_PRIVACY_FILTER_SETTINGS,
            enabled: true,
            categories: {
                secrets: false,
                email: false,
                phone: false,
                privatePerson: false,
                privateAddress: false,
                privateDate: false,
                account: false,
                paymentCard: false,
                ipAddress: false,
                url: false,
            },
            useLocalModel: false,
            maskedWords: [customTerm],
        };

        const result = await maskAiMessages([{ role: 'user', content: text }], settings);

        expect(String(result.messages[0]?.content)).not.toContain(customTerm);
        expect(result.session.restoreText(String(result.messages[0]?.content))).toContain(
            customTerm
        );
    });

    it('user switches from algorithm rules to a model then their custom word still masks the outgoing text', async () => {
        const settings = {
            ...DEFAULT_PRIVACY_FILTER_SETTINGS,
            enabled: true,
            categories: {
                secrets: false,
                email: false,
                phone: false,
                privatePerson: false,
                privateAddress: false,
                privateDate: false,
                account: false,
                paymentCard: false,
                ipAddress: false,
                url: false,
            },
            maskedWords: ['Nightfall'],
            useLocalModel: false,
        };
        const messages = [{ role: 'user' as const, content: 'Project Nightfall' }];
        const rules = await maskAiMessages(messages, settings);
        expect(rules.messages[0]?.content).not.toContain('Nightfall');
        const model = await maskAiMessages(messages, { ...settings, useLocalModel: true });
        expect(model.messages[0]?.content).not.toContain('Nightfall');
    });

    it('user masks a detected name then settings receives its memory-only replacement separately from request statistics', async () => {
        const name = ['Morgan', 'Lee'].join(' ');
        const text = `Please contact ${name} today.`;
        privacyModel.getModelStatus.mockResolvedValue({ installed: true });
        privacyModel.detect.mockResolvedValue([
            [
                {
                    start: text.indexOf(name),
                    end: text.indexOf(name) + name.length,
                    kind: 'private_person',
                    score: 0.95,
                },
            ],
        ]);
        const result = await maskAiMessages(
            [
                {
                    role: 'user',
                    content: text,
                    contextSource: { id: 41, fingerprint: 'a'.repeat(64) },
                },
            ],
            {
                ...DEFAULT_PRIVACY_FILTER_SETTINGS,
                enabled: true,
                categories: { ...DEFAULT_PRIVACY_FILTER_SETTINGS.categories, privatePerson: true },
            }
        );
        await recordPrivacyProtection(result.session);
        const [summary, details] = privacyModel.recordProtection.mock.calls[0]!;
        expect(summary).toEqual({
            mode: 'model',
            outcome: 'protected',
            maskedCount: 1,
            categories: [{ kind: 'privatePerson', count: 1 }],
        });
        expect(details).toEqual({
            values: [
                {
                    kind: 'privatePerson',
                    original: name,
                    placeholder: result.annotations[0]!.placeholder,
                    count: 1,
                    matches: [{ id: 'localModel', modelId: 'astrlink-guard-int8', count: 1 }],
                },
            ],
            texts: [result.messages[0]!.content],
            truncated: false,
        });
        expect(JSON.stringify(summary)).not.toContain(name);
        expect(result.annotations).toEqual([
            {
                messageId: 41,
                textHash: expect.stringMatching(/^[0-9a-f]{64}$/),
                start: text.indexOf(name),
                end: text.indexOf(name) + name.length,
                original: name,
                placeholder: expect.stringMatching(/^\{\{PERSON_[0-9a-f]{16}\}\}$/),
                kind: 'privatePerson',
                rule: { id: 'localModel', modelId: 'astrlink-guard-int8' },
            },
        ]);
        expect(result.messages[0]?.content).not.toContain(name);
        expect(result.session.restoreText(String(result.messages[0]?.content))).toBe(text);
    });

    it('user encounters a protection record save failure then reply restoration still works and a later record includes replacements', async () => {
        const text = 'Email ada@example.test';
        const result = await maskAiMessages([{ role: 'user', content: text }], {
            ...DEFAULT_PRIVACY_FILTER_SETTINGS,
            enabled: true,
            useLocalModel: false,
            categories: { ...DEFAULT_PRIVACY_FILTER_SETTINGS.categories, email: true },
        });
        privacyModel.recordProtection.mockRejectedValueOnce(new Error('Unavailable'));
        await expect(recordPrivacyProtection(result.session)).resolves.toBeUndefined();
        expect(result.messages[0]?.content).not.toContain('ada@example.test');
        expect(result.session.restoreText(String(result.messages[0]?.content))).toBe(text);
        privacyModel.recordProtection.mockResolvedValue(undefined);
        await recordPrivacyProtection(result.session);
        expect(privacyModel.recordProtection.mock.lastCall?.[1].values).toEqual([
            expect.objectContaining({ original: 'ada@example.test', count: 1 }),
        ]);
    });

    it('user selects an alternative installed model then that model handles local detection', async () => {
        privacyModel.getModelStatus.mockResolvedValue({ installed: true });
        privacyModel.detect.mockResolvedValue([[]]);
        await maskAiMessages(
            [{ role: 'user', content: 'A simple message' }],
            { ...DEFAULT_PRIVACY_FILTER_SETTINGS, enabled: true },
            'openmed-privacy-filter'
        );
        expect(privacyModel.getModelStatus).toHaveBeenCalledWith('openmed-privacy-filter');
        expect(privacyModel.detect).toHaveBeenCalledWith(
            ['A simple message'],
            'openmed-privacy-filter'
        );
    });

    it('user keeps attachment names and paths private when messages are prepared for a provider', async () => {
        const privateEmail = 'ada@example.test';
        const sourceMessage: AiMessage = {
            role: 'tool',
            name: 'builtin__browser',
            tool_call_id: 'call_attachment',
            content: [
                {
                    type: 'file',
                    name: 'report.pdf',
                    sourcePath: `C:\\Users\\${privateEmail}\\reports\\report.pdf`,
                    size: 12,
                    mimeType: 'application/pdf',
                    kind: 'pdf',
                    semanticIntent: 'document-content',
                    base64Data: 'JVBERi0=',
                    meta: {
                        alias: 'A1',
                        order: 0,
                        type: 'file',
                        name: `report for ${privateEmail}.pdf`,
                        mimeType: 'application/pdf',
                        originPath: `C:\\Users\\${privateEmail}\\reports\\report.pdf`,
                        attachmentId: 1,
                        hash: null,
                    },
                },
            ],
        };
        const settings: PrivacyFilterSettings = {
            ...DEFAULT_PRIVACY_FILTER_SETTINGS,
            enabled: true,
            categories: {
                ...DEFAULT_PRIVACY_FILTER_SETTINGS.categories,
                secrets: false,
                email: true,
            },
            useLocalModel: false,
        };
        const sourceSnapshot = JSON.stringify(sourceMessage);

        const masked = await maskAiMessages([sourceMessage], settings);
        const outgoing = await buildModelMessages({
            messages: prepareModelRequest(
                { model: 'gpt-4.1', messages: masked.messages },
                { driver: 'openai', providerId: 1, resourceKey: () => undefined }
            ).messages,
            providerDriver: 'openai',
            modelId: 'gpt-4.1',
        });
        const providerMessages = JSON.stringify(outgoing.messages);

        expect(providerMessages).not.toContain(privateEmail);
        expect(providerMessages.match(/\{\{EMAIL_[0-9a-f]{16}\}\}/g)).toHaveLength(2);
        expect(JSON.stringify(sourceMessage)).toBe(sourceSnapshot);
    });

    it('user sees custom terms masked at the correct position after Unicode text', async () => {
        const customTerm = 'private-term';
        const text = `İ ${customTerm}`;
        const settings: PrivacyFilterSettings = {
            ...DEFAULT_PRIVACY_FILTER_SETTINGS,
            enabled: true,
            categories: {
                secrets: false,
                email: false,
                phone: false,
                privatePerson: false,
                privateAddress: false,
                privateDate: false,
                account: false,
                paymentCard: false,
                ipAddress: false,
                url: false,
            },
            useLocalModel: false,
            maskedWords: [customTerm],
        };

        const result = await maskAiMessages([{ role: 'user', content: text }], settings);
        const outgoingContent = String(result.messages[0]?.content);

        expect(outgoingContent).not.toContain(customTerm);
        expect(result.session.restoreText(outgoingContent)).toBe(text);
    });

    it('user keeps detected names out of the prompt when the local model is installed', async () => {
        const name = 'Morgan Lee';
        const text = `Please contact ${name} today.`;
        privacyModel.getModelStatus.mockResolvedValue({ installed: true });
        privacyModel.detect.mockResolvedValue([
            [
                {
                    start: text.indexOf(name),
                    end: text.indexOf(name) + name.length,
                    kind: 'private_person',
                    score: 0.95,
                },
            ],
        ]);
        const settings: PrivacyFilterSettings = {
            ...DEFAULT_PRIVACY_FILTER_SETTINGS,
            enabled: true,
            categories: {
                ...DEFAULT_PRIVACY_FILTER_SETTINGS.categories,
                secrets: false,
                privatePerson: true,
            },
            confidenceThreshold: 0.8,
        };

        const result = await maskAiMessages([{ role: 'user', content: text }], settings);
        const outgoingContent = String(result.messages[0]?.content);

        expect(outgoingContent).not.toContain(name);
        expect(result.session.restoreText(outgoingContent)).toContain(name);
    });

    it('user keeps text from reaching a provider when local detection fails before a request', async () => {
        const message = [{ role: 'user' as const, content: 'Contact Morgan Lee.' }];
        privacyModel.getModelStatus.mockResolvedValue({ installed: true });
        privacyModel.detect.mockRejectedValueOnce(new Error('Local model is unavailable'));
        const settings: PrivacyFilterSettings = {
            ...DEFAULT_PRIVACY_FILTER_SETTINGS,
            enabled: true,
            categories: {
                ...DEFAULT_PRIVACY_FILTER_SETTINGS.categories,
                secrets: false,
                privatePerson: true,
            },
        };

        await expect(maskAiMessages(message, settings)).rejects.toThrow(
            'Local model is unavailable'
        );
        privacyModel.detect.mockResolvedValueOnce([[]]);
        await expect(maskAiMessages(message, settings)).resolves.toMatchObject({
            messages: [{ content: 'Contact Morgan Lee.' }],
        });
    });

    it('user masks multiple messages then an incomplete model result fails the request instead of treating messages as scanned', async () => {
        privacyModel.getModelStatus.mockResolvedValue({ installed: true });
        privacyModel.detect.mockResolvedValue([[]]);

        await expect(
            maskAiMessages(
                [
                    { role: 'user', content: 'First message' },
                    { role: 'user', content: 'Second message' },
                ],
                { ...DEFAULT_PRIVACY_FILTER_SETTINGS, enabled: true }
            )
        ).rejects.toThrow('Invalid local privacy detection response');
    });
});

describe('given a user has disabled privacy filtering', () => {
    beforeEach(() => {
        vi.stubGlobal('crypto', webcrypto);
        privacyModel.getModelStatus.mockReset();
        privacyModel.detect.mockReset();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('user keeps text unchanged when a request is prepared', async () => {
        const secret = 'sk-test12345678901234567890';
        const sourceMessages = [{ role: 'user' as const, content: `Use this key: ${secret}` }];

        const result = await maskAiMessages(sourceMessages, DEFAULT_PRIVACY_FILTER_SETTINGS);

        expect(result.messages[0]?.content).toContain(secret);
        expect(privacyModel.getModelStatus).not.toHaveBeenCalled();
    });
});
