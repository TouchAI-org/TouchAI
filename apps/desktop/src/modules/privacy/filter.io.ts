import { log } from '@/platform/diagnostics';
import { native } from '@/platform/native';

import type { PrivacyFilterModelId, PrivacyProtectionRule } from './contracts';
import type { PrivacyMaskingSession, PrivacyMaskingSpan } from './masking';
import { PRIVACY_DATA_TYPES, type PrivacyDataType, type PrivacyFilterSettings } from './settings';
interface MaskRange {
    start: number;
    end: number;
    kind: string;
    score: number;
    rule: PrivacyProtectionRule;
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
    }

    // User-defined prefixes are explicit rules, independent of any category switch.
    for (const prefix of settings.secretPrefixes) {
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

    for (const word of settings.maskedWords) {
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

async function findRanges(
    texts: string[],
    settings: PrivacyFilterSettings,
    useModel: boolean,
    session: PrivacyMaskingSession,
    modelId: PrivacyFilterModelId
): Promise<MaskRange[][]> {
    let modelRanges: MaskRange[][] = [];

    if (useModel && shouldUseLocalModel(settings)) {
        const status = await native.privacyFilter.getModelStatus(modelId);
        if (!status.installed || status.downloading)
            throw new Error('The selected local privacy model is unavailable');
        const detections = await native.privacyFilter.detect(texts, modelId);
        if (
            !Array.isArray(detections) ||
            detections.length !== texts.length ||
            !detections.every((spans) => Array.isArray(spans))
        )
            throw new Error('Invalid local privacy detection response');
        session.markLocalModelUsed();
        modelRanges = texts.map((text, index) =>
            detections[index]!.filter(
                (span) =>
                    span.start >= 0 &&
                    span.end > span.start &&
                    span.end <= text.length &&
                    span.score >= settings.confidenceThreshold &&
                    isModelKindAllowed(span.kind, settings)
            ).map((span) => ({
                start: span.start,
                end: span.end,
                kind: span.kind,
                score: span.score,
                rule: { id: 'localModel' as const, modelId },
            }))
        );
    }

    return texts.map((text, index) =>
        excludeNeverMaskRanges(
            text,
            [...detectRuleRanges(text, settings), ...(modelRanges[index] ?? [])],
            settings.neverMask
        )
    );
}

export async function maskTexts(
    texts: string[],
    settings: PrivacyFilterSettings,
    session: PrivacyMaskingSession,
    useModel: boolean,
    modelId: PrivacyFilterModelId,
    onAccepted?: (index: number, span: PrivacyMaskingSpan, original: string) => void
): Promise<string[]> {
    const rangesByText = await findRanges(texts, settings, useModel, session, modelId);
    return Promise.all(
        texts.map(async (text, index) => {
            // Merge before hashing: a placeholder must identify the entire covered original.
            const merged: MaskRange[] = [];
            for (const range of (rangesByText[index] ?? []).sort(
                (a, b) => a.start - b.start || b.end - a.end
            )) {
                const previous = merged[merged.length - 1];
                if (previous && range.start < previous.end)
                    previous.end = Math.max(previous.end, range.end);
                else merged.push({ ...range });
            }
            const spans: PrivacyMaskingSpan[] = await Promise.all(
                merged.map(async (range) => ({
                    ...range,
                    placeholder: await createPlaceholder(
                        range.kind,
                        text.slice(range.start, range.end)
                    ),
                }))
            );
            return session.maskText(text, spans, (span, original) =>
                onAccepted?.(index, span, original)
            );
        })
    );
}

export async function recordPrivacyRestoration(
    session: PrivacyMaskingSession,
    context?: { sessionId?: number; modelName?: string },
    currentGeneration = session.reviewGeneration
): Promise<void> {
    const summary = session.restorationSummary();
    if (!summary.maskedCount || session.reviewGeneration !== currentGeneration) return;
    try {
        await native.privacyFilter.recordRestoration(
            { ...summary, mode: session.mode, outcome: 'protected', ...context },
            session.restorationDetails(),
            session.recordGeneration
        );
    } catch {
        log.warn('[PrivacyProtection] Reply restoration record could not be saved');
    }
}

export async function recordPrivacyProtection(
    session: PrivacyMaskingSession,
    outcome: 'protected' | 'blocked' = 'protected',
    mode = session.mode,
    context?: { sessionId?: number; modelName?: string },
    currentGeneration = session.reviewGeneration
): Promise<void> {
    const summary = session.protectionSummary();
    if (
        session.reviewGeneration !== currentGeneration ||
        (summary.maskedCount === 0 && outcome === 'protected')
    )
        return;
    try {
        await native.privacyFilter.recordProtection(
            {
                ...summary,
                mode,
                outcome,
                ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
                ...(context?.modelName ? { modelName: context.modelName } : {}),
            },
            session.protectionDetails(),
            session.recordGeneration
        );
    } catch {
        log.warn('[PrivacyProtection] Request record could not be saved');
    }
}

export const getPrivacyRecordGeneration = native.privacyFilter.getRecordGeneration;
