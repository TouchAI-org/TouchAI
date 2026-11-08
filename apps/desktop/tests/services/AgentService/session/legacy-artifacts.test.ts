import { describe, expect, it } from 'vitest';

import { LegacyArtifactHistory } from '@/services/AgentService/session/legacyArtifacts';
import type { LegacyArtifactInfo, SessionMessage } from '@/types/session';

function legacyArtifact(widgetId: string, callId: string): LegacyArtifactInfo {
    return {
        id: widgetId,
        widgetId,
        callId,
        title: widgetId,
        description: '',
        html: `<p>${widgetId}</p>`,
        mode: 'render',
        phase: 'ready',
        updatedAt: 1,
    };
}

function message(id: string): SessionMessage {
    return { id, role: 'assistant', content: '', parts: [], timestamp: 1 };
}

describe('when a user reopens a conversation with pre-OpenUI artifacts', () => {
    it('user sees persisted artifact content restored on the assistant reply that created it', () => {
        const reply = message('reply-1');
        const history = [reply];
        const widgets = new LegacyArtifactHistory();

        widgets.upsertArtifact(history, reply.id, {
            ...legacyArtifact('sales-chart', 'call-1'),
        });

        expect(reply.legacyArtifacts?.[0]).toMatchObject({
            widgetId: 'sales-chart',
            html: '<p>sales-chart</p>',
        });
        expect(reply.parts).toContainEqual(
            expect.objectContaining({ type: 'widget', widgetId: 'sales-chart' })
        );
    });

    it('user sees a legacy artifact removed without affecting the rest of the reply', () => {
        const reply = message('reply-1');
        const history = [reply];
        const widgets = new LegacyArtifactHistory();
        widgets.upsertArtifact(history, reply.id, legacyArtifact('sales-chart', 'call-1'));

        widgets.removeArtifactById(history, 'sales-chart');

        expect(reply.legacyArtifacts).toEqual([]);
        expect(reply.parts).toEqual([]);
    });
});
