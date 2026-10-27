import 'zone.js';

import {
    type Attributes,
    context,
    type Span,
    SpanKind,
    SpanStatusCode,
    trace,
} from '@opentelemetry/api';
import { ZoneContextManager } from '@opentelemetry/context-zone';
import { TracerProvider } from '@opentelemetry/sdk-trace';

let provider: TracerProvider | null = null;
let contextManager: ZoneContextManager | null = null;
let tracer = trace.getTracer('touchai.desktop');

export function initTracing(): void {
    if (provider) return;
    contextManager = new ZoneContextManager().enable();
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
