import {
    ANALYTICS_SEND_PATH,
    analyticsSendUrl,
    buildAnalyticsWireEvent,
    isSupportedAnalyticsProtocolVersion,
} from '@services/AnalyticsService/transport';
import { ANALYTICS_WIRE_HOSTNAME, ANALYTICS_WIRE_URL } from '@services/AnalyticsService/types';
import { describe, expect, it } from 'vitest';

describe('AnalyticsService transport contract', () => {
    it('user gets the Umami required website host and url in one wire event', () => {
        const wire = buildAnalyticsWireEvent({
            websiteId: '11111111-1111-4111-8111-111111111111',
            installationId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
            eventName: 'app.started',
            occurredAtMs: 1_760_000_000_500,
            data: {
                event_id: '1a2b3c4d-5e6f-4a70-8b91-c2d3e4f5a701',
                occurred_at_ms: 1_760_000_000_500,
                schema_version: 1,
                app_version: '1.2.2',
                release_channel: 'stable',
                os_family: 'linux',
                architecture: 'x86_64',
                run_id: '92a3b4c5-d6e7-4bf8-8c09-eafb0c1d2e09',
                startup_source: 'foreground',
            },
        });

        expect(wire.type).toBe('event');
        expect(wire.payload.website).toBe('11111111-1111-4111-8111-111111111111');
        expect(wire.payload.id).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
        expect(wire.payload.name).toBe('app.started');
        expect(wire.payload.timestamp).toBe(1_760_000_000);
        expect(wire.payload.hostname).toBe(ANALYTICS_WIRE_HOSTNAME);
        expect(wire.payload.url).toBe(ANALYTICS_WIRE_URL);
        expect(wire.payload.data.run_id).toBe('92a3b4c5-d6e7-4bf8-8c09-eafb0c1d2e09');
    });

    it('user gets the send path appended without a doubled slash', () => {
        expect(analyticsSendUrl('https://analytics.touch-ai.org/touchai-app/v1')).toBe(
            `https://analytics.touch-ai.org/touchai-app/v1${ANALYTICS_SEND_PATH}`
        );
        expect(analyticsSendUrl('https://analytics.touch-ai.org/touchai-app/v1/')).toBe(
            `https://analytics.touch-ai.org/touchai-app/v1${ANALYTICS_SEND_PATH}`
        );
    });

    it('user gets only the pinned protocol version accepted', () => {
        expect(isSupportedAnalyticsProtocolVersion(1)).toBe(true);
        expect(isSupportedAnalyticsProtocolVersion(2)).toBe(false);
    });
});
