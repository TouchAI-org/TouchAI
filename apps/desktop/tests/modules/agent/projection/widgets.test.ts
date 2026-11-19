import { describe, expect, it } from 'vitest';

import type { SessionMessage } from '@/app/api/agent/history';
import type { WidgetPayload } from '@/modules/agent/contracts/presentation';
import { ProjectionWidgets } from '@/modules/agent/projection/widgets';

const widgetToolName = 'builtin__show_widget';
const message = (id = 'message-1'): SessionMessage => ({
    id,
    role: 'assistant',
    content: '',
    parts: [],
    timestamp: 0,
});
const payload = (overrides: Partial<WidgetPayload> = {}): WidgetPayload => ({
    callId: 'call-1',
    widgetId: 'widget-1',
    title: 'Sales',
    description: 'By region',
    html: '<div>1</div>',
    mode: 'render',
    phase: 'draft',
    ...overrides,
});
const widgetParts = (target: SessionMessage) =>
    target.parts.flatMap((part) => (part.type === 'widget' ? [part.widgetId] : []));

describe('given Widget validation and draft pacing are owned by tools', () => {
    it('user receives a draft with its metadata and one rendered part in the current reply', () => {
        const target = message();
        const widgets = new ProjectionWidgets(widgetToolName);
        widgets.upsertWidget([target], target.id, payload());
        expect(target.widgets).toMatchObject([
            {
                callId: 'call-1',
                widgetId: 'widget-1',
                title: 'Sales',
                description: 'By region',
                html: '<div>1</div>',
                phase: 'draft',
            },
        ]);
        expect(widgetParts(target)).toEqual(['widget-1']);
    });

    it('user sees the draft filled in without duplicating its rendered part when the payload is repeated', () => {
        const target = message();
        const widgets = new ProjectionWidgets(widgetToolName);
        widgets.upsertWidget([target], target.id, payload());
        widgets.upsertWidget([target], target.id, payload({ html: '<div>1</div><p>done</p>' }));
        widgets.upsertWidget([target], target.id, payload({ html: '<div>1</div><p>done</p>' }));
        expect(target.widgets).toHaveLength(1);
        expect(target.widgets?.[0]?.html).toBe('<div>1</div><p>done</p>');
        expect(widgetParts(target)).toEqual(['widget-1']);
    });

    it('user sees the final title, description and markup replace a draft in the same reply', () => {
        const target = message();
        const widgets = new ProjectionWidgets(widgetToolName);
        widgets.upsertWidget([target], target.id, payload());
        widgets.upsertWidget(
            [target],
            target.id,
            payload({
                phase: 'ready',
                title: 'Sales overview',
                description: 'All regions',
                html: '<div>chart</div>',
            })
        );
        expect(target.widgets).toMatchObject([
            {
                title: 'Sales overview',
                description: 'All regions',
                html: '<div>chart</div>',
                phase: 'ready',
            },
        ]);
        expect(widgetParts(target)).toEqual(['widget-1']);
    });

    it('user keeps one widget and its rendered part when the same call changes its generated identity', () => {
        const target = message();
        const widgets = new ProjectionWidgets(widgetToolName);
        widgets.upsertWidget([target], target.id, payload({ widgetId: 'draft-id' }));
        widgets.upsertWidget([target], target.id, payload({ widgetId: 'final-id' }));
        expect(target.widgets).toHaveLength(1);
        expect(target.widgets?.[0]?.widgetId).toBe('final-id');
        expect(widgetParts(target)).toEqual(['final-id']);
    });

    it('user sees an update target the existing widget rather than duplicate it in a later reply', () => {
        const older = message('older');
        const current = message('current');
        const widgets = new ProjectionWidgets(widgetToolName);
        widgets.upsertWidget([older], older.id, payload({ phase: 'ready' }));
        widgets.upsertWidget(
            [older, current],
            current.id,
            payload({ callId: 'call-2', phase: 'ready', html: '<p>updated</p>' })
        );
        expect(older.widgets).toMatchObject([{ callId: 'call-2', html: '<p>updated</p>' }]);
        expect(current.widgets).toBeUndefined();
        expect(widgetParts(older)).toEqual(['widget-1']);
    });

    it('user sees the widget and its rendered part removed when the model deletes it', () => {
        const target = message();
        const widgets = new ProjectionWidgets(widgetToolName);
        widgets.upsertWidget([target], target.id, payload());
        widgets.removeWidgetByWidgetId([target], 'widget-1', target.id);
        expect(target.widgets).toEqual([]);
        expect(widgetParts(target)).toEqual([]);
    });

    it('user keeps a finished widget when a later failed draft is discarded', () => {
        const target = message();
        const widgets = new ProjectionWidgets(widgetToolName);
        widgets.upsertWidget([target], target.id, payload({ phase: 'ready' }));
        widgets.upsertWidget(
            [target],
            target.id,
            payload({ callId: 'call-2', widgetId: 'draft-2' })
        );
        widgets.finalizeToolCall([target], 'call-2', { removeDraft: true });
        expect(target.widgets).toMatchObject([{ widgetId: 'widget-1', phase: 'ready' }]);
        expect(widgetParts(target)).toEqual(['widget-1']);
    });

    it('user receives no fabricated reply when a widget targets a missing message', () => {
        const target = message();
        const widgets = new ProjectionWidgets(widgetToolName);
        expect(widgets.upsertWidget([target], 'missing', payload())).toBeNull();
        expect(target.widgets).toBeUndefined();
        expect(target.parts).toEqual([]);
    });

    it('user sees the Widget call hidden while other builtin calls remain visible', () => {
        const widgets = new ProjectionWidgets(widgetToolName);
        expect(widgets.isHiddenBuiltinToolCall(widgetToolName)).toBe(true);
        expect(widgets.isHiddenBuiltinToolCall('builtin__bash')).toBe(false);
    });
});
