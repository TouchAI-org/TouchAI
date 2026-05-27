export type PerformanceTraceName =
    | 'search.shortcut.received'
    | 'search.window.show-start'
    | 'search.window.visible'
    | 'search.input.ready'
    | 'search.input.first-accepted'
    | 'search.resize.observed'
    | 'search.resize.requested'
    | 'search.resize.sent'
    | 'search.resize.committed'
    | 'search.resize.settled'
    | 'search.resize.dropped'
    | 'startup.ready'
    | 'diagnostics.enabled';

export interface PerformanceTraceEvent {
    name: PerformanceTraceName;
    at: number;
    fields?: Record<string, string | number | boolean>;
}

interface TraceOptions {
    capacity?: number;
    now?: () => number;
}

let enabled = false;
let capacity = 200;
let nowProvider = () => performance.now();
const events: PerformanceTraceEvent[] = [];

export function setPerformanceTraceEnabled(nextEnabled: boolean, options: TraceOptions = {}): void {
    enabled = nextEnabled;

    if (options.capacity !== undefined) {
        const normalizedCapacity = Number.isFinite(options.capacity)
            ? Math.max(0, Math.floor(options.capacity))
            : 0;
        capacity = normalizedCapacity;

        if (events.length > capacity) {
            events.splice(0, events.length - capacity);
        }
    }

    nowProvider = options.now ?? nowProvider;
}

export function markPerformanceTrace(
    name: PerformanceTraceName,
    fields?: PerformanceTraceEvent['fields']
): void {
    if (!enabled) {
        return;
    }

    events.push({
        name,
        at: nowProvider(),
        fields,
    });

    while (events.length > capacity) {
        events.shift();
    }
}

export function getPerformanceTraceSnapshot(): PerformanceTraceEvent[] {
    return events.map((event) => ({
        ...event,
        fields: event.fields ? { ...event.fields } : undefined,
    }));
}

export function clearPerformanceTrace(): void {
    events.length = 0;
}
