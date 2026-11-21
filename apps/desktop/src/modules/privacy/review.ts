import type {
    PrivacyRestoredSpan,
    PrivacyReviewAnnotation,
    PrivacyReviewSnapshot,
} from './contracts';
export { sha256Text as hashPrivacyText } from '@/utils/hash';

const encoder = new TextEncoder();
export function createPrivacyReview() {
    const ENTRY_LIMIT = 200;
    const BYTE_LIMIT = 64 * 1024;
    let entries: PrivacyReviewAnnotation[] = [];
    const listeners = new Set<() => void>();
    const notify = () => {
        for (const listener of listeners) listener();
    };
    let generation = 0;

    function privacyReviewGeneration(): number {
        return generation;
    }

    function publishPrivacyReview(
        annotations: PrivacyReviewAnnotation[],
        expectedGeneration = generation
    ): void {
        if (expectedGeneration !== generation) return;
        const additions = annotations
            .filter(
                (annotation) =>
                    ((typeof annotation.messageId === 'number' &&
                        Number.isSafeInteger(annotation.messageId) &&
                        annotation.messageId > 0 &&
                        /^[0-9a-f]{64}$/.test(annotation.textHash)) ||
                        (typeof annotation.messageId === 'string' &&
                            annotation.messageId.startsWith('reply:') &&
                            annotation.textHash === '')) &&
                    Number.isInteger(annotation.start) &&
                    annotation.start >= 0 &&
                    Number.isInteger(annotation.end) &&
                    annotation.end > annotation.start &&
                    annotation.original.length === annotation.end - annotation.start &&
                    annotation.placeholder.length > 0
            )
            .map((annotation) => ({
                ...annotation,
                ...(annotation.rule ? { rule: { ...annotation.rule } } : {}),
            }));
        const existingKeys = new Set(
            entries.map(
                (entry) =>
                    `${entry.messageId}:${entry.textHash}:${entry.start}:${entry.end}:${entry.placeholder}`
            )
        );
        const uniqueAdditions = additions.filter((entry) => {
            const key = `${entry.messageId}:${entry.textHash}:${entry.start}:${entry.end}:${entry.placeholder}`;
            if (existingKeys.has(key)) return false;
            existingKeys.add(key);
            return true;
        });
        const next = [...entries, ...uniqueAdditions].slice(-ENTRY_LIMIT);
        while (next.length && encoder.encode(JSON.stringify(next)).length > BYTE_LIMIT)
            next.shift();
        entries = next;
        notify();
    }

    function clearPrivacyReview(): void {
        generation += 1;
        entries = [];
        notify();
    }

    function hasPrivacyAnnotations(messageId: number | undefined): boolean {
        return Boolean(messageId && entries.some((entry) => entry.messageId === messageId));
    }

    function selectPrivacyAnnotations(
        messageId: number | undefined,
        text: string,
        textHash: string
    ): PrivacyReviewAnnotation[] {
        if (!messageId || !textHash) return [];
        const spans = entries
            .filter(
                (entry) =>
                    entry.messageId === messageId &&
                    entry.textHash === textHash &&
                    text.slice(entry.start, entry.end) === entry.original
            )
            .sort((a, b) => a.start - b.start);
        const result: PrivacyReviewAnnotation[] = [];
        let end = 0;
        for (const span of spans) {
            if (span.start < end) continue;
            result.push(span);
            end = span.end;
        }
        return result;
    }

    function publishRestoredPrivacyReview(
        partId: string,
        offset: number,
        spans: PrivacyRestoredSpan[],
        expectedGeneration: number
    ): void {
        if (!spans.length) return;
        publishPrivacyReview(
            spans.map((span) => ({
                ...span,
                messageId: `reply:${partId}`,
                textHash: '',
                start: offset + span.start,
                end: offset + span.end,
            })),
            expectedGeneration
        );
    }

    function selectRestoredPrivacyAnnotations(
        partId: string | undefined,
        text: string
    ): PrivacyReviewAnnotation[] {
        if (!partId) return [];
        return entries.filter(
            (entry) =>
                entry.messageId === `reply:${partId}` &&
                text.slice(entry.start, entry.end) === entry.original
        );
    }

    return Object.freeze({
        privacyReviewGeneration,
        publishPrivacyReview,
        clearPrivacyReview,
        hasPrivacyAnnotations,
        selectPrivacyAnnotations,
        publishRestoredPrivacyReview,
        selectRestoredPrivacyAnnotations,
        getReviewSnapshot: (): PrivacyReviewSnapshot => ({
            generation,
            annotations: structuredClone(entries),
        }),
        subscribeReview(listener: () => void) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        dispose() {
            clearPrivacyReview();
            listeners.clear();
        },
    });
}
export type PrivacyReview = ReturnType<typeof createPrivacyReview>;
