import type { ModelMessage } from 'ai';

import type { AiMessage, AiStreamChunk } from '@/services/AgentService/contracts/protocol';
import { native } from '@/services/NativeService';
import {
    DEFAULT_PRIVACY_MODEL_ID,
    type PrivacyFilterModelId,
    type PrivacyProtectionRule,
} from '@/services/NativeService/privacyFilter';
import { log } from '@/services/ObservabilityService';
import {
    PRIVACY_DATA_TYPES,
    type PrivacyDataType,
    type PrivacyFilterSettings,
} from '@services/SettingsService/domain';

import { PrivacyMaskingSession, type PrivacyMaskingSpan } from './privacyMasking';

interface TextTarget {
    value: string;
    write(value: string): void;
}

interface MaskRange {
    start: number;
    end: number;
    kind: string;
    score: number;
    rule: PrivacyProtectionRule;
}

interface PrivacyMaskingResult<T = ModelMessage> {
    messages: T[];
    session: PrivacyMaskingSession;
}

const SECRET_PATTERNS = [
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]{1,16384}?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi,
    /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|xox(?:b|p|o|a|r|s)-[A-Za-z0-9-]{10,}|sk_live_[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|hf_[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{20,}|dop_v1_[A-Za-z0-9_-]{20,}|SG\.[A-Za-z0-9._-]{20,})\b/gi,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    /\b(?:[A-Z0-9_]*(?:API[_-]?KEY|CLIENT[_-]?SECRET|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|PASSWORD|PASSWD|CREDENTIALS?))\b\s*[:=]\s*(?:"[^"]{1,2048}"|'[^']{1,2048}'|[^\s,;#]{1,2048})/gi,
    /\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]{1,128}:([^@\s]{1,512})@/gi,
];

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_PATTERN =
    /(?<!\w)(?:\+?\d{1,3}[ .-]?)?(?:\(?\d{2,4}\)?[ .-]?)?\d{3,4}[ .-]?\d{4}(?!\w)/g;
const CHINA_ID_PATTERN = /\b\d{17}[\dXx]\b/g;
const BANK_CARD_PATTERN = /\b(?:\d[ -]?){13,19}\b/g;

function isLuhnValid(value: string): boolean {
    const digits = value.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) {
        return false;
    }

    let sum = 0;
    let doubleDigit = false;
    for (let index = digits.length - 1; index >= 0; index -= 1) {
        let digit = Number(digits[index]);
        if (doubleDigit) {
            digit *= 2;
            if (digit > 9) digit -= 9;
        }
        sum += digit;
        doubleDigit = !doubleDigit;
    }
    return sum % 10 === 0;
}

function isChinaIdValid(value: string): boolean {
    const normalized = value.toUpperCase();
    const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    const checks = '10X98765432';
    const sum = [...normalized.slice(0, 17)].reduce(
        (total, digit, index) => total + Number(digit) * (weights[index] ?? 0),
        0
    );
    return checks[sum % 11] === normalized[17];
}

function privacyDataTypeForKind(kind: string): PrivacyDataType | null {
    const normalized = kind.toLocaleLowerCase().replace(/^private_/, '');
    const aliases: Record<string, PrivacyDataType> = {
        email: 'email',
        phone: 'phone',
        person: 'privatePerson',
        privateperson: 'privatePerson',
        address: 'privateAddress',
        privateaddress: 'privateAddress',
        date: 'privateDate',
        privatedate: 'privateDate',
        account: 'account',
        payment_card: 'paymentCard',
        paymentcard: 'paymentCard',
        ip_address: 'ipAddress',
        ipaddress: 'ipAddress',
        url: 'url',
    };
    return aliases[normalized] ?? null;
}

function isEnabledDataType(settings: PrivacyFilterSettings, kind: string): boolean {
    const dataType = privacyDataTypeForKind(kind);
    return Boolean(dataType && settings.categories[dataType]);
}

function addMatches(
    text: string,
    pattern: RegExp,
    kind: string,
    ranges: MaskRange[],
    rule: PrivacyProtectionRule,
    validate?: (value: string) => boolean,
    valueGroup?: number
): void {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
        const value = valueGroup ? match[valueGroup] : match[0];
        if (!value || (validate && !validate(value))) {
            continue;
        }
        const matchStart = match.index ?? 0;
        const start = valueGroup ? matchStart + match[0].indexOf(value) : matchStart;
        ranges.push({ start, end: start + value.length, kind, score: 1, rule });
    }
}

function addLiteralMatches(
    text: string,
    value: string,
    kind: string,
    ranges: MaskRange[],
    rule: PrivacyProtectionRule
): void {
    for (const { start, end } of findLiteralRanges(text, value)) {
        ranges.push({ start, end, kind, score: 1, rule });
    }
}

function findLiteralRanges(text: string, value: string): Array<{ start: number; end: number }> {
    if (!value) return [];

    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = text.matchAll(new RegExp(escaped, 'giu'));
    return [...matches].map((match) => {
        const start = match.index ?? 0;
        return { start, end: start + match[0].length };
    });
}

function detectRuleRanges(text: string, settings: PrivacyFilterSettings): MaskRange[] {
    const ranges: MaskRange[] = [];
    if (settings.categories.secrets) {
        addMatches(text, SECRET_PATTERNS[0]!, 'private_key', ranges, { id: 'privateKey' });
        addMatches(text, SECRET_PATTERNS[1]!, 'api_key', ranges, { id: 'apiKey' });
        addMatches(text, SECRET_PATTERNS[2]!, 'jwt', ranges, { id: 'jwt' });
        addMatches(
            text,
            SECRET_PATTERNS[3]!,
            'secret',
            ranges,
            { id: 'secretAssignment' },
            undefined,
            0
        );
        addMatches(
            text,
            SECRET_PATTERNS[4]!,
            'url_password',
            ranges,
            { id: 'urlPassword' },
            undefined,
            1
        );
        for (const prefix of settings.useLocalModel ? [] : settings.secretPrefixes) {
            for (const { start, end: prefixEnd } of findLiteralRanges(text, prefix)) {
                let end = prefixEnd;
                while (end < text.length && !/[\s,;#]/.test(text[end] ?? '')) end += 1;
                if (end > prefixEnd) {
                    ranges.push({
                        start,
                        end,
                        kind: 'custom_secret',
                        score: 1,
                        rule: { id: 'customPrefix', value: prefix },
                    });
                }
            }
        }
    }

    if (PRIVACY_DATA_TYPES.some((type) => settings.categories[type])) {
        if (settings.categories.email) {
            addMatches(text, EMAIL_PATTERN, 'email', ranges, { id: 'email' });
        }
        if (settings.categories.phone) {
            addMatches(text, PHONE_PATTERN, 'phone', ranges, { id: 'phone' }, (value) => {
                const digits = value.replace(/\D/g, '');
                return digits.length >= 10 && digits.length <= 15;
            });
        }
        if (settings.categories.account) {
            addMatches(
                text,
                CHINA_ID_PATTERN,
                'account',
                ranges,
                { id: 'chinaId' },
                isChinaIdValid
            );
        }
        if (settings.categories.paymentCard) {
            addMatches(
                text,
                BANK_CARD_PATTERN,
                'payment_card',
                ranges,
                { id: 'paymentCard' },
                isLuhnValid
            );
        }
    }

    for (const word of settings.useLocalModel ? [] : settings.maskedWords) {
        addLiteralMatches(text, word, 'term', ranges, { id: 'customWord', value: word });
    }
    return ranges;
}

function excludeNeverMaskRanges(
    text: string,
    ranges: MaskRange[],
    neverMask: string[]
): MaskRange[] {
    if (neverMask.length === 0) return ranges;
    const exactExclusions = new Set(neverMask.map((item) => item.toLocaleLowerCase()));
    const excludedOccurrences: Array<{ start: number; end: number }> = [];
    for (const item of neverMask) {
        excludedOccurrences.push(...findLiteralRanges(text, item));
    }

    return ranges.filter((range) => {
        if (exactExclusions.has(text.slice(range.start, range.end).toLocaleLowerCase())) {
            return false;
        }
        return !excludedOccurrences.some(
            (excluded) => range.start < excluded.end && range.end > excluded.start
        );
    });
}

async function createPlaceholder(kind: string, value: string): Promise<string> {
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi?.subtle) {
        throw new Error('Privacy filtering requires the Web Crypto API');
    }

    const keyName = '__touchaiPrivacyMaskKey';
    const runtime = globalThis as typeof globalThis & { [keyName]?: Promise<CryptoKey> };
    runtime[keyName] ??= (async () => {
        const keyBytes = cryptoApi.getRandomValues(new Uint8Array(32));
        return cryptoApi.subtle.importKey(
            'raw',
            keyBytes,
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        );
    })();
    const key = await runtime[keyName]!;
    const digest = new Uint8Array(
        await cryptoApi.subtle.sign('HMAC', key, new TextEncoder().encode(`${kind}\0${value}`))
    );
    const suffix = [...digest.slice(0, 8)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    const tag = kind
        .replace(/^private_/, '')
        .replace(/[^a-z0-9]+/gi, '_')
        .toLocaleUpperCase();
    return `{{${tag}_${suffix}}}`;
}

function isModelKindAllowed(kind: string, settings: PrivacyFilterSettings): boolean {
    if (kind.toLocaleLowerCase() === 'common_secret') {
        return settings.categories.secrets;
    }
    return isEnabledDataType(settings, kind);
}

function shouldUseLocalModel(settings: PrivacyFilterSettings): boolean {
    return (
        settings.useLocalModel &&
        (PRIVACY_DATA_TYPES.some((type) => settings.categories[type]) ||
            settings.categories.secrets)
    );
}

function setTarget(target: TextTarget, text: string): void {
    target.write(text);
}

function collectTextTargets(messages: ModelMessage[]): TextTarget[] {
    const targets: TextTarget[] = [];
    const add = (value: unknown, write: (value: string) => void) => {
        if (typeof value === 'string' && value.length > 0) {
            targets.push({ value, write });
        }
    };

    for (const message of messages) {
        const content = (message as { content?: unknown }).content;
        if (typeof content === 'string') {
            add(content, (value) => {
                (message as { content: string }).content = value;
            });
            continue;
        }
        if (!Array.isArray(content)) continue;

        for (const part of content as Array<Record<string, unknown>>) {
            if (
                (part.type === 'text' || part.type === 'reasoning') &&
                typeof part.text === 'string'
            ) {
                add(part.text, (value) => {
                    part.text = value;
                });
            } else if (part.type === 'tool-call' && part.input !== undefined) {
                let serialized: string;
                try {
                    serialized = JSON.stringify(part.input) ?? '{}';
                } catch {
                    continue;
                }
                add(serialized, (value) => {
                    part.input = JSON.parse(value) as unknown;
                });
            } else if (
                part.type === 'tool-result' &&
                part.output &&
                typeof part.output === 'object'
            ) {
                const output = part.output as Record<string, unknown>;
                if (output.type === 'text' && typeof output.value === 'string') {
                    add(output.value, (value) => {
                        output.value = value;
                    });
                } else if (output.type === 'content' && Array.isArray(output.value)) {
                    for (const outputPart of output.value as Array<Record<string, unknown>>) {
                        if (outputPart.type === 'text' && typeof outputPart.text === 'string') {
                            add(outputPart.text, (value) => {
                                outputPart.text = value;
                            });
                        }
                    }
                }
            }
        }
    }
    return targets;
}

async function findRanges(
    texts: string[],
    settings: PrivacyFilterSettings,
    useModel: boolean,
    session: PrivacyMaskingSession,
    modelId: PrivacyFilterModelId
): Promise<MaskRange[][]> {
    const ruleRanges = texts.map((text) => detectRuleRanges(text, settings));
    let modelRanges: MaskRange[][] = texts.map(() => []);

    if (useModel && shouldUseLocalModel(settings)) {
        const status = await native.privacyFilter.getModelStatus(modelId);
        if (status.installed) {
            const detections = await native.privacyFilter.detect(texts, modelId);
            session.markLocalModelUsed();
            modelRanges = texts.map((text, index) =>
                (detections[index] ?? [])
                    .filter(
                        (span) =>
                            span.start >= 0 &&
                            span.end > span.start &&
                            span.end <= text.length &&
                            span.score >= settings.confidenceThreshold &&
                            isModelKindAllowed(span.kind, settings)
                    )
                    .map((span) => ({
                        start: span.start,
                        end: span.end,
                        kind: span.kind,
                        score: span.score,
                        rule: { id: 'localModel' as const, modelId },
                    }))
            );
        }
    }

    return texts.map((text, index) =>
        excludeNeverMaskRanges(
            text,
            [...(ruleRanges[index] ?? []), ...(modelRanges[index] ?? [])],
            settings.neverMask
        )
    );
}

async function maskTexts(
    texts: string[],
    settings: PrivacyFilterSettings,
    session: PrivacyMaskingSession,
    useModel: boolean,
    modelId: PrivacyFilterModelId
): Promise<string[]> {
    const rangesByText = await findRanges(texts, settings, useModel, session, modelId);
    return Promise.all(
        texts.map(async (text, index) => {
            const spans: PrivacyMaskingSpan[] = await Promise.all(
                (rangesByText[index] ?? []).map(async (range) => ({
                    ...range,
                    placeholder: await createPlaceholder(
                        range.kind,
                        text.slice(range.start, range.end)
                    ),
                }))
            );
            return session.maskText(text, spans);
        })
    );
}

export async function maskModelMessages(
    sourceMessages: ModelMessage[],
    settings: PrivacyFilterSettings,
    existingSession = new PrivacyMaskingSession(),
    useModel = true,
    modelId: PrivacyFilterModelId = DEFAULT_PRIVACY_MODEL_ID
): Promise<PrivacyMaskingResult> {
    if (!settings.enabled) {
        return { messages: sourceMessages, session: existingSession };
    }

    const messages = sourceMessages.map((message) => ({ ...message })) as ModelMessage[];
    for (let index = 0; index < messages.length; index += 1) {
        const content = (sourceMessages[index] as { content?: unknown }).content;
        if (Array.isArray(content)) {
            (messages[index] as { content: unknown }).content = content.map((part) => {
                if (!part || typeof part !== 'object') return part;
                const cloned = { ...(part as Record<string, unknown>) };
                if (
                    cloned.type === 'tool-result' &&
                    cloned.output &&
                    typeof cloned.output === 'object'
                ) {
                    const output = cloned.output as Record<string, unknown>;
                    cloned.output = {
                        ...output,
                        ...(Array.isArray(output.value)
                            ? {
                                  value: output.value.map((item) =>
                                      item && typeof item === 'object'
                                          ? { ...(item as Record<string, unknown>) }
                                          : item
                                  ),
                              }
                            : {}),
                    };
                }
                return cloned;
            });
        }
    }

    const targets = collectTextTargets(messages);
    if (targets.length === 0) {
        return { messages, session: existingSession };
    }
    const masked = await maskTexts(
        targets.map((target) => target.value),
        settings,
        existingSession,
        useModel,
        modelId
    );
    targets.forEach((target, index) => setTarget(target, masked[index] ?? target.value));
    return { messages, session: existingSession };
}

function cloneAiMessages(source: AiMessage[]): AiMessage[] {
    return source.map((message) => ({
        ...message,
        content: Array.isArray(message.content)
            ? message.content.map((part) =>
                  part.type === 'file' || part.type === 'image'
                      ? { ...part, meta: { ...part.meta } }
                      : part.type === 'tool_use'
                        ? { ...part, input: { ...part.input } }
                        : { ...part }
              )
            : message.content,
        tool_calls: message.tool_calls?.map((toolCall) => ({ ...toolCall })),
    }));
}

function collectAiMessageTextTargets(messages: AiMessage[]): TextTarget[] {
    const targets: TextTarget[] = [];
    const add = (value: unknown, write: (value: string) => void) => {
        if (typeof value === 'string' && value.length > 0) {
            targets.push({ value, write });
        }
    };

    for (const message of messages) {
        if (typeof message.content === 'string') {
            add(message.content, (value) => {
                message.content = value;
            });
        } else {
            for (const part of message.content) {
                switch (part.type) {
                    case 'text':
                    case 'reasoning':
                        add(part.text, (value) => {
                            part.text = value;
                        });
                        break;
                    case 'file':
                        add(part.name, (value) => {
                            part.name = value;
                        });
                        add(part.meta.name, (value) => {
                            part.meta.name = value;
                        });
                        add(part.meta.originPath, (value) => {
                            part.meta.originPath = value;
                        });
                        if (part.textContent !== undefined) {
                            add(part.textContent, (value) => {
                                part.textContent = value;
                            });
                        }
                        break;
                    case 'image':
                        add(part.name, (value) => {
                            part.name = value;
                        });
                        add(part.meta.name, (value) => {
                            part.meta.name = value;
                        });
                        add(part.meta.originPath, (value) => {
                            part.meta.originPath = value;
                        });
                        break;
                    case 'tool_use': {
                        let serialized: string;
                        try {
                            serialized = JSON.stringify(part.input) ?? '{}';
                        } catch {
                            break;
                        }
                        add(serialized, (value) => {
                            try {
                                part.input = JSON.parse(value) as Record<string, unknown>;
                            } catch {
                                part.input = {};
                            }
                        });
                        break;
                    }
                    case 'tool_result':
                        add(part.content, (value) => {
                            part.content = value;
                        });
                        break;
                }
            }
        }

        for (const toolCall of message.tool_calls ?? []) {
            add(toolCall.arguments, (value) => {
                toolCall.arguments = value;
            });
        }
    }
    return targets;
}

export async function maskAiMessages(
    sourceMessages: AiMessage[],
    settings: PrivacyFilterSettings,
    modelId: PrivacyFilterModelId = DEFAULT_PRIVACY_MODEL_ID
): Promise<PrivacyMaskingResult<AiMessage>> {
    const session = new PrivacyMaskingSession();
    if (!settings.enabled) {
        return { messages: sourceMessages, session };
    }
    const messages = cloneAiMessages(sourceMessages);

    const targets = collectAiMessageTextTargets(messages);
    if (targets.length === 0) {
        return { messages, session };
    }
    const masked = await maskTexts(
        targets.map((target) => target.value),
        settings,
        session,
        true,
        modelId
    );
    targets.forEach((target, index) => setTarget(target, masked[index] ?? target.value));
    return { messages, session };
}

export function restorePrivacyChunk(
    chunk: AiStreamChunk,
    session: PrivacyMaskingSession,
    restoredToolBuffers: Map<string, string>
): AiStreamChunk {
    const restored = { ...chunk };
    restored.content = session.pushText(chunk.content, 'content');
    if (chunk.textState === 'end' || chunk.done) {
        restored.content += session.flushText('content');
    }
    if (typeof chunk.reasoning === 'string') {
        restored.reasoning = session.pushText(chunk.reasoning, 'reasoning');
    }
    if (chunk.reasoningState === 'end' || chunk.done) {
        restored.reasoning = (restored.reasoning ?? '') + session.flushText('reasoning');
    }
    if (chunk.toolCallDeltas) {
        restored.toolCallDeltas = chunk.toolCallDeltas.map((delta) => {
            const streamId = `tool:${delta.index}`;
            if (delta.isComplete && typeof delta.argumentsBuffer === 'string') {
                restoredToolBuffers.delete(streamId);
                session.flushText(streamId);
                return {
                    ...delta,
                    argumentsBuffer: session.restoreToolArguments(delta.argumentsBuffer),
                };
            }
            const originalDelta = delta.argumentsDelta ?? '';
            const visibleDelta = session.pushText(originalDelta, streamId);
            const visibleArguments = `${restoredToolBuffers.get(streamId) ?? ''}${visibleDelta}`;
            restoredToolBuffers.set(streamId, visibleArguments);
            return {
                ...delta,
                argumentsDelta: visibleDelta,
                argumentsBuffer: visibleArguments,
            };
        });
    }
    if (chunk.toolCalls) {
        restored.toolCalls = chunk.toolCalls.map((toolCall) => ({
            ...toolCall,
            arguments: session.restoreToolArguments(toolCall.arguments),
        }));
    }
    return restored;
}

export const PRIVACY_FILTER_DATA_TYPES = PRIVACY_DATA_TYPES;

export async function recordPrivacyProtection(
    session: PrivacyMaskingSession,
    outcome: 'protected' | 'blocked' = 'protected',
    mode = session.mode
): Promise<void> {
    const summary = session.protectionSummary();
    if (summary.maskedCount === 0 && outcome === 'protected') return;
    try {
        const record = { ...summary, mode, outcome };
        if (summary.maskedCount > 0) {
            await native.privacyFilter.recordProtection(record, session.protectionDetails());
        } else {
            await native.privacyFilter.recordProtection(record);
        }
    } catch {
        log.warn('[PrivacyProtection] Request record could not be saved');
    }
}
