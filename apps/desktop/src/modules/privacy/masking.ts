import {
    PRIVACY_FILTER_DETAIL_BYTES_LIMIT,
    PRIVACY_FILTER_DETAIL_TEXTS_LIMIT,
    PRIVACY_FILTER_DETAIL_VALUES_LIMIT,
    type PrivacyProtectionDetails,
    type PrivacyProtectionKind,
    type PrivacyProtectionRule,
    type PrivacyProtectionSummary,
    type PrivacyProtectionValue,
} from '@/services/NativeService/privacyFilter';

const DETAIL_PART_BYTES_LIMIT = PRIVACY_FILTER_DETAIL_BYTES_LIMIT / 2;
const textEncoder = new TextEncoder();

export interface PrivacyMaskingSpan {
    start: number;
    end: number;
    kind: string;
    placeholder: string;
    rule?: PrivacyProtectionRule;
}

export class PrivacyMaskingSession {
    private readonly originalsByPlaceholder = new Map<string, string>();
    private readonly pendingTextByStream = new Map<string, string>();
    private readonly protectedCounts = new Map<PrivacyProtectionKind, number>();
    private readonly protectedValues = new Map<
        string,
        Omit<PrivacyProtectionValue, 'original' | 'placeholder'>
    >();
    private readonly protectedTexts: string[] = [];
    private detailValueBytes = 0;
    private detailTextBytes = 0;
    private detailsTruncated = false;
    private usedLocalModel = false;

    get mode(): 'rules' | 'model' {
        return this.usedLocalModel ? 'model' : 'rules';
    }

    markLocalModelUsed(): void {
        this.usedLocalModel = true;
    }

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
                original: this.originalsByPlaceholder.get(placeholder)!,
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

    maskText(text: string, spans: PrivacyMaskingSpan[]): string {
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
        const acceptedSpans: PrivacyMaskingSpan[] = [];
        let consumedUntil = 0;

        for (const span of orderedSpans) {
            if (span.start < consumedUntil) {
                continue;
            }
            acceptedSpans.push(span);
            consumedUntil = span.end;
            const original = text.slice(span.start, span.end);
            this.originalsByPlaceholder.set(span.placeholder, original);
            const kind = protectionKind(span.kind);
            this.protectedCounts.set(kind, (this.protectedCounts.get(kind) ?? 0) + 1);
            this.rememberValue(span.placeholder, original, kind, span.rule);
        }

        if (acceptedSpans.length === 0) {
            return text;
        }

        let cursor = 0;
        let masked = '';
        for (const span of acceptedSpans) {
            masked += text.slice(cursor, span.start) + span.placeholder;
            cursor = span.end;
        }
        masked += text.slice(cursor);
        this.rememberText(masked);
        return masked;
    }

    private rememberValue(
        placeholder: string,
        original: string,
        kind: PrivacyProtectionKind,
        rule?: PrivacyProtectionRule
    ): void {
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
        const value = { kind, count: 1 };
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

    private rememberText(masked: string): void {
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

    restoreText(text: string): string {
        let restored = text;
        for (const [placeholder, original] of this.originalsByPlaceholder) {
            restored = restored.split(placeholder).join(original);
        }
        return restored;
    }

    pushText(chunk: string, streamId = 'default'): string {
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
                visible += pending.slice(cursor, nextPlaceholder.index) + nextPlaceholder.original;
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
        return this.restoreText(pending);
    }

    restoreToolArguments(value: string): string {
        return this.restoreText(value);
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
function protectionKind(kind: string): PrivacyProtectionKind {
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
