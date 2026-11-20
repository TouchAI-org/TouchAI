import { context, trace } from '@opentelemetry/api';

const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export function formatTraceparent(traceId: string, spanId: string, flags = '01'): string {
    if (
        !/^[0-9a-f]{32}$/.test(traceId) ||
        !/^[0-9a-f]{16}$/.test(spanId) ||
        !/^[0-9a-f]{2}$/.test(flags)
    ) {
        throw new Error('Invalid trace context');
    }
    return `00-${traceId}-${spanId}-${flags}`;
}

export function currentTraceparent(): string | undefined {
    const spanContext = trace.getSpan(context.active())?.spanContext();
    if (!spanContext || !trace.isSpanContextValid(spanContext)) {
        return undefined;
    }
    return formatTraceparent(
        spanContext.traceId,
        spanContext.spanId,
        (spanContext.traceFlags & 0xff).toString(16).padStart(2, '0')
    );
}

export function isValidTraceparent(value: string): boolean {
    if (!TRACEPARENT_PATTERN.test(value)) return false;
    const [, traceId, spanId] = TRACEPARENT_PATTERN.exec(value) ?? [];
    return Boolean(traceId && spanId && /[1-9a-f]/.test(traceId) && /[1-9a-f]/.test(spanId));
}
