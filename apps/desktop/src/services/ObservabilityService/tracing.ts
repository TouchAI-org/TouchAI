import {
    type Attributes,
    context,
    type Span,
    SpanKind,
    SpanStatusCode,
    trace,
} from '@opentelemetry/api';
import { ZoneContextManager } from '@opentelemetry/context-zone-peer-dep';
import { StackContextManager, TracerProvider } from '@opentelemetry/sdk-trace';

let provider: TracerProvider | null = null;
let contextManager: ZoneContextManager | StackContextManager | null = null;
let tracer = trace.getTracer('touchai.desktop');

export function initTracing(): void {
    if (provider) return;
    // zone.js is loaded by initializeApp, not by this module: importing it from
    // here patched timers in every Vitest worker and changed microtask ordering.
    // Tests fall back to the synchronous stack manager below.
    contextManager =
        typeof (globalThis as { Zone?: unknown }).Zone === 'undefined'
            ? new StackContextManager().enable()
            : new ZoneContextManager().enable();
    context.setGlobalContextManager(contextManager);
    provider = new TracerProvider();
    trace.setGlobalTracerProvider(provider);
    tracer = provider.getTracer('touchai.desktop');
}

export async function withSpan<T>(
    name: string,
    attributes: Attributes,
    fn: (span: Span) => Promise<T>,
    parentSpan?: Span
): Promise<T> {
    initTracing();
    const parentContext = parentSpan
        ? trace.setSpan(context.active(), parentSpan)
        : context.active();
    const span = tracer.startSpan(
        name,
        {
            attributes,
            kind: SpanKind.INTERNAL,
        },
        parentContext
    );

    return context.with(trace.setSpan(parentContext, span), async () => {
        try {
            const result = await fn(span);
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
        } catch (error) {
            span.recordException(error instanceof Error ? error : String(error));
            span.setStatus({
                code: SpanStatusCode.ERROR,
                message: error instanceof Error ? error.message : String(error),
            });
            throw error;
        } finally {
            span.end();
        }
    });
}

export function activeSpanContext(): { traceId: string; spanId: string } | undefined {
    const spanContext = trace.getSpan(context.active())?.spanContext();
    if (!spanContext || !trace.isSpanContextValid(spanContext)) return undefined;
    return { traceId: spanContext.traceId, spanId: spanContext.spanId };
}

export function resetTracingForTests(): void {
    void provider?.shutdown();
    provider = null;
    contextManager?.disable();
    contextManager = null;
    context.disable();
    trace.disable();
    tracer = trace.getTracer('touchai.desktop');
}
