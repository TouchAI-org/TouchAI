import type { PrivacyRestoredSpan } from './contracts';
import {
    PRIVACY_FILTER_DETAIL_BYTES_LIMIT,
    PRIVACY_FILTER_DETAIL_TEXTS_LIMIT,
    PRIVACY_FILTER_DETAIL_VALUES_LIMIT,
    type PrivacyProtectionDetails,
    type PrivacyProtectionKind,
    type PrivacyProtectionRule,
    type PrivacyProtectionSummary,
    type PrivacyProtectionValue,
} from './contracts';

const DETAIL_PART_BYTES_LIMIT = PRIVACY_FILTER_DETAIL_BYTES_LIMIT / 2;
const textEncoder = new TextEncoder();

export interface PrivacyMaskingSpan {
    start: number;
    end: number;
    kind: string;
    placeholder: string;
    rule?: PrivacyProtectionRule;
}

class PrivacyProtectionCapture {
    private readonly protectedCounts = new Map<PrivacyProtectionKind, number>();
    private readonly protectedValues = new Map<
        string,
        Omit<PrivacyProtectionValue, 'placeholder'>
    >();
    private readonly protectedTexts: string[] = [];
    private readonly textIndexByStream = new Map<string, number>();
    private detailValueBytes = 0;
    private detailTextBytes = 0;
    private detailsTruncated = false;
    protectionSummary(): PrivacyProtectionSummary {
        const categories = [...this.protectedCounts].map(([kind, count]) => ({ kind, count }));
        return {
            maskedCount: categories.reduce((sum, category) => sum + category.count, 0),
            categories,
        };
    }

    protectionDetails(): PrivacyProtectionDetails {
        const values: PrivacyProtectionValue[] = [];
        for (const [placeholder, value] of this.protectedValues) {
            values.push({
                ...value,
                placeholder,
                ...(value.matches ? { matches: value.matches.map((match) => ({ ...match })) } : {}),
            });
        }
        const incompleteRules = values.some(
            (value) =>
                value.matches &&
                value.matches.reduce((sum, match) => sum + match.count, 0) < value.count
        );
        return {
            values,
            texts: [...this.protectedTexts],
            truncated: this.detailsTruncated || incompleteRules,
        };
    }

    rememberValue(
        placeholder: string,
        original: string,
        kind: PrivacyProtectionKind,
        rule?: PrivacyProtectionRule
    ): void {
        this.protectedCounts.set(kind, (this.protectedCounts.get(kind) ?? 0) + 1);
        const previous = this.protectedValues.get(placeholder);
        if (previous) {
            previous.count += 1;
            this.rememberRule(previous, rule);
            return;
        }
        const remaining = DETAIL_PART_BYTES_LIMIT - this.detailValueBytes;
        if (
            this.protectedValues.size >= PRIVACY_FILTER_DETAIL_VALUES_LIMIT ||
            original.length + placeholder.length > remaining
        ) {
            this.detailsTruncated = true;
            return;
        }
        const bytes = textEncoder.encode(original).length + textEncoder.encode(placeholder).length;
        if (bytes > remaining) {
            this.detailsTruncated = true;
            return;
        }
        const value = { kind, original, count: 1 };
        this.protectedValues.set(placeholder, value);
        this.detailValueBytes += bytes;
        this.rememberRule(value, rule);
    }

    private rememberRule(
        value: Omit<PrivacyProtectionValue, 'original' | 'placeholder'>,
        rule?: PrivacyProtectionRule
    ): void {
        if (!rule) return;
        const existing = value.matches?.find(
            (match) =>
                match.id === rule.id &&
                ('value' in match ? match.value : undefined) ===
                    ('value' in rule ? rule.value : undefined) &&
                ('modelId' in match ? match.modelId : undefined) ===
                    ('modelId' in rule ? rule.modelId : undefined)
        );
        if (existing) {
            existing.count += 1;
            return;
        }
        // Reserve the largest accepted count so later repeated hits cannot exceed the byte cap.
        const bytes = textEncoder.encode(JSON.stringify({ ...rule, count: 1_000_000 })).length + 3;
        if (bytes > DETAIL_PART_BYTES_LIMIT - this.detailValueBytes) {
            this.detailsTruncated = true;
            return;
        }
        (value.matches ??= []).push({ ...rule, count: 1 });
        this.detailValueBytes += bytes;
    }

    rememberText(masked: string): void {
        if (this.protectedTexts.includes(masked)) return;
        const remaining = DETAIL_PART_BYTES_LIMIT - this.detailTextBytes;
        if (
            this.protectedTexts.length >= PRIVACY_FILTER_DETAIL_TEXTS_LIMIT ||
            masked.length > remaining
        ) {
            this.detailsTruncated = true;
            return;
        }
        const bytes = textEncoder.encode(masked).length;
        if (bytes > remaining) {
            this.detailsTruncated = true;
            return;
        }
        this.protectedTexts.push(masked);
        this.detailTextBytes += bytes;
    }

    appendText(chunk: string, streamId: string): void {
        if (!chunk || (this.detailsTruncated && this.detailTextBytes >= DETAIL_PART_BYTES_LIMIT))
            return;
        const bytes = textEncoder.encode(chunk).length;
        if (bytes > DETAIL_PART_BYTES_LIMIT - this.detailTextBytes) {
            this.detailsTruncated = true;
            this.detailTextBytes = DETAIL_PART_BYTES_LIMIT;
            return;
        }
        let index = this.textIndexByStream.get(streamId);
        if (index === undefined) {
            if (this.protectedTexts.length >= PRIVACY_FILTER_DETAIL_TEXTS_LIMIT) {
                this.detailsTruncated = true;
                return;
            }
            index = this.protectedTexts.length;
            this.textIndexByStream.set(streamId, index);
            this.protectedTexts.push('');
        }
        this.protectedTexts[index] = (this.protectedTexts[index] ?? '') + chunk;
        this.detailTextBytes += bytes;
    }
}

export class PrivacyMaskingSession {
    constructor(
        readonly reviewGeneration = 0,
        readonly recordGeneration?: number
    ) {}
    private readonly originalsByPlaceholder = new Map<string, string>();
    private readonly rulesByPlaceholder = new Map<
        string,
        Pick<PrivacyRestoredSpan, 'kind' | 'rule'>
    >();
    private readonly pendingTextByStream = new Map<string, string>();
    private readonly jsonStrings = new Map<string, { text: string; escaped: boolean }>();
    private readonly protection = new PrivacyProtectionCapture();
    private readonly restoration = new PrivacyProtectionCapture();
    private usedLocalModel = false;

    get mode(): 'rules' | 'model' {
        return this.usedLocalModel ? 'model' : 'rules';
    }

    markLocalModelUsed(): void {
        this.usedLocalModel = true;
    }

    protectionSummary(): PrivacyProtectionSummary {
        return this.protection.protectionSummary();
    }

    protectionDetails(): PrivacyProtectionDetails {
        return this.protection.protectionDetails();
    }

    restorationSummary(): PrivacyProtectionSummary {
        return this.restoration.protectionSummary();
    }

    restorationDetails(): PrivacyProtectionDetails {
        return this.restoration.protectionDetails();
    }

    captureRestoredContent(
        chunk: string,
        spans: PrivacyRestoredSpan[],
        streamId = 'content'
    ): void {
        this.restoration.appendText(chunk, streamId);
        for (const span of spans) {
            this.restoration.rememberValue(span.placeholder, span.original, span.kind, span.rule);
        }
    }

    maskText(
        text: string,
        spans: PrivacyMaskingSpan[],
        onAccepted?: (span: PrivacyMaskingSpan, original: string) => void
    ): string {
        const orderedSpans = spans
            .filter(
                (span) =>
                    Number.isInteger(span.start) &&
                    Number.isInteger(span.end) &&
                    span.start >= 0 &&
                    span.end > span.start &&
                    span.end <= text.length &&
                    span.placeholder.length > 0
            )
            .sort((left, right) => left.start - right.start || right.end - left.end);
        let cursor = 0;
        let masked = '';
        let accepted = false;
        for (const span of orderedSpans) {
            if (span.start < cursor && span.end > cursor)
                throw new Error('Unmerged privacy detection ranges');
            if (span.start < cursor) continue;
            accepted = true;
            const original = text.slice(span.start, span.end);
            const kind = protectionKind(span.kind);
            this.originalsByPlaceholder.set(span.placeholder, original);
            this.rulesByPlaceholder.set(span.placeholder, {
                kind,
                ...(span.rule ? { rule: { ...span.rule } } : {}),
            });
            this.protection.rememberValue(span.placeholder, original, kind, span.rule);
            onAccepted?.(span, original);
            masked += text.slice(cursor, span.start) + span.placeholder;
            cursor = span.end;
        }
        if (!accepted) return text;
        masked += text.slice(cursor);
        this.protection.rememberText(masked);
        return masked;
    }

    restoreText(text: string, onRestored?: (span: PrivacyRestoredSpan) => void): string {
        const streamId = 'complete-value';
        return this.pushText(text, streamId, onRestored) + this.flushText(streamId);
    }

    pushText(
        chunk: string,
        streamId = 'default',
        onRestored?: (span: PrivacyRestoredSpan) => void
    ): string {
        const pending = (this.pendingTextByStream.get(streamId) ?? '') + chunk;
        let cursor = 0;
        let visible = '';
        let nextPending = '';

        while (cursor < pending.length) {
            let nextPlaceholder: { index: number; value: string; original: string } | undefined;
            for (const [value, original] of this.originalsByPlaceholder) {
                const index = pending.indexOf(value, cursor);
                if (index >= 0 && (!nextPlaceholder || index < nextPlaceholder.index)) {
                    nextPlaceholder = { index, value, original };
                }
            }

            if (nextPlaceholder) {
                visible += pending.slice(cursor, nextPlaceholder.index);
                const start = visible.length;
                visible += nextPlaceholder.original;
                onRestored?.({
                    start,
                    end: visible.length,
                    original: nextPlaceholder.original,
                    placeholder: nextPlaceholder.value,
                    ...this.rulesByPlaceholder.get(nextPlaceholder.value)!,
                });
                cursor = nextPlaceholder.index + nextPlaceholder.value.length;
                continue;
            }

            const remainder = pending.slice(cursor);
            const heldLength = this.longestPlaceholderPrefixSuffix(remainder);
            visible += heldLength > 0 ? remainder.slice(0, -heldLength) : remainder;
            nextPending = heldLength > 0 ? remainder.slice(-heldLength) : '';
            cursor = pending.length;
        }

        this.pendingTextByStream.set(streamId, nextPending);
        return visible;
    }

    flushText(streamId = 'default'): string {
        const pending = this.pendingTextByStream.get(streamId) ?? '';
        this.pendingTextByStream.delete(streamId);
        // Only an incomplete placeholder prefix can remain after pushText.
        return pending;
    }

    restoreToolArguments(value: string, captureId?: string): string {
        const spans: PrivacyRestoredSpan[] = [];
        const restored: unknown = JSON.parse(value, (_key, item: unknown) =>
            typeof item === 'string' ? this.restoreText(item, (span) => spans.push(span)) : item
        );
        if (captureId) this.captureRestoredContent(value, spans, captureId);
        return JSON.stringify(restored);
    }

    pushToolArguments(chunk: string, streamId: string): string {
        // JSON.parse owns escapes. Buffer only the current string literal, never reparsing
        // an ever-growing object or injecting unescaped originals into the protocol.
        let pending = this.jsonStrings.get(streamId);
        let output = '';
        for (const char of chunk) {
            if (!pending) {
                if (char === '"') pending = { text: char, escaped: false };
                else output += char;
                continue;
            }
            pending.text += char;
            if (pending.text.length > 1024 * 1024)
                throw new Error('Privacy tool string exceeds the input limit');
            if (pending.escaped) pending.escaped = false;
            else if (char === '\\') pending.escaped = true;
            else if (char === '"') {
                output += JSON.stringify(this.restoreText(JSON.parse(pending.text) as string));
                pending = undefined;
            }
        }
        if (pending) this.jsonStrings.set(streamId, pending);
        else this.jsonStrings.delete(streamId);
        return output;
    }

    finishToolArguments(streamId: string): void {
        this.jsonStrings.delete(streamId);
    }

    private longestPlaceholderPrefixSuffix(value: string): number {
        let longest = 0;
        for (const placeholder of this.originalsByPlaceholder.keys()) {
            const maximum = Math.min(value.length, placeholder.length - 1);
            for (let length = maximum; length > longest; length -= 1) {
                if (placeholder.startsWith(value.slice(-length))) {
                    longest = length;
                    break;
                }
            }
        }
        return longest;
    }
}
export function protectionKind(kind: string): PrivacyProtectionKind {
    const kinds: Record<string, PrivacyProtectionKind> = {
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
        term: 'custom',
        custom_secret: 'custom',
    };
    return kinds[kind.toLowerCase().replace(/^private_/, '')] ?? 'secret';
}
