import type { SessionMessage } from '@/types/session';

interface LatestCompletedMessageMarkerParts {
    sessionId: number;
    messageId: string;
    timestamp: number;
    content: string;
    reasoning: string | null;
    statusText: string | null;
    isError: boolean;
    isCancelled: boolean;
    isRetrying: boolean;
    parts: string[];
    toolCalls: string[];
    approvals: string[];
    widgets: string[];
}

export interface SearchAutoShrinkEligibilityInput {
    timedOut: boolean;
    sessionIdle: boolean;
    latestCompletedMessageMarker: string | null;
    latestSeenCompletedMessageMarker: string | null;
}

function hasPendingToolCalls(message: SessionMessage): boolean {
    return (
        message.toolCalls?.some(
            (toolCall) =>
                toolCall.status === 'executing' || toolCall.status === 'awaiting_approval'
        ) ?? false
    );
}

function hasPendingApprovals(message: SessionMessage): boolean {
    return message.approvals?.some((approval) => approval.status === 'pending') ?? false;
}

function isAssistantMessageSettled(message: SessionMessage): boolean {
    return (
        message.role === 'assistant' &&
        message.isStreaming !== true &&
        !hasPendingToolCalls(message) &&
        !hasPendingApprovals(message)
    );
}

export function findLatestSettledAssistantMessage(
    messages: SessionMessage[]
): SessionMessage | null {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message && isAssistantMessageSettled(message)) {
            return message;
        }
    }

    return null;
}

export function isSessionHistorySettled(messages: SessionMessage[]): boolean {
    const latestAssistantMessage = findLatestSettledAssistantMessage(messages);
    if (!latestAssistantMessage) {
        return false;
    }

    return messages.every((message) => {
        if (message.role !== 'assistant') {
            return true;
        }

        return isAssistantMessageSettled(message);
    });
}

function buildLatestCompletedMessageMarkerParts(
    sessionId: number,
    message: SessionMessage
): LatestCompletedMessageMarkerParts {
    return {
        sessionId,
        messageId: message.id,
        timestamp: message.timestamp,
        content: message.content,
        reasoning: message.reasoning ?? null,
        statusText: message.statusText ?? null,
        isError: message.isError === true,
        isCancelled: message.isCancelled === true,
        isRetrying: message.isRetrying === true,
        parts: message.parts.map((part) => {
            switch (part.type) {
                case 'tool_call':
                    return `${part.type}:${part.id}:${part.callId}`;
                case 'approval':
                    return `${part.type}:${part.id}:${part.callId}`;
                case 'widget':
                    return `${part.type}:${part.id}:${part.widgetId}`;
                default:
                    return `${part.type}:${part.id}:${part.content}`;
            }
        }),
        toolCalls:
            message.toolCalls?.map(
                (toolCall) => `${toolCall.id}:${toolCall.status}:${toolCall.result}`
            ) ?? [],
        approvals: message.approvals?.map((approval) => `${approval.id}:${approval.status}`) ?? [],
        widgets: message.widgets?.map((widget) => `${widget.id}:${widget.updatedAt}`) ?? [],
    };
}

export function buildLatestCompletedMessageMarker(
    sessionId: number | null,
    messages: SessionMessage[]
): string | null {
    if (sessionId === null) {
        return null;
    }

    if (!isSessionHistorySettled(messages)) {
        return null;
    }

    const latestAssistantMessage = findLatestSettledAssistantMessage(messages);
    if (!latestAssistantMessage) {
        return null;
    }

    return JSON.stringify(
        buildLatestCompletedMessageMarkerParts(sessionId, latestAssistantMessage)
    );
}

export function shouldAutoShrinkSearchSession(input: SearchAutoShrinkEligibilityInput): boolean {
    return (
        input.timedOut &&
        input.sessionIdle &&
        input.latestCompletedMessageMarker !== null &&
        input.latestCompletedMessageMarker === input.latestSeenCompletedMessageMarker
    );
}
