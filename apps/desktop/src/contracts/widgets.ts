// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

export type ShowWidgetMode = 'render' | 'remove';
export type ShowWidgetPhase = 'draft' | 'ready';

/**
 * Stable payload shared by the show_widget runtime, agent projection, and session display.
 */
export interface ShowWidgetPayload {
    callId: string;
    widgetId: string;
    title: string;
    description: string;
    html: string;
    mode: ShowWidgetMode;
    phase: ShowWidgetPhase;
}

export type ShowWidgetEventPayload = ShowWidgetPayload;
