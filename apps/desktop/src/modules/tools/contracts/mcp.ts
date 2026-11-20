import type { ToolAttachment, ToolMessages } from './host';

export type McpConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface McpConnectionEvent {
    serverId: number;
    status: McpConnectionStatus;
    error: string | null;
}

export interface McpToolContent {
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mime_type?: string;
    uri?: string;
    blob?: string;
}

export interface McpCallResponse {
    success: boolean;
    content: McpToolContent[];
    is_error: boolean;
}

export interface McpResourceCapabilities {
    create(resource: {
        type: 'image' | 'file';
        name: string;
        originPath: string;
        mimeType?: string;
        size: number;
        data: Uint8Array;
    }): Promise<ToolAttachment>;
}

export interface McpConnectionsOptions {
    messages: ToolMessages;
    resources: McpResourceCapabilities;
    diagnostics: {
        debug(message: string, ...details: unknown[]): void;
        error(message: string, ...details: unknown[]): void;
    };
}
