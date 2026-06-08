import { invoke } from '@tauri-apps/api/core';

import type {
    BrowserActRequest,
    BrowserActResponse,
    BrowserConnectExistingRequest,
    BrowserConnectExistingResponse,
    BrowserExistingSession,
    BrowserNavigationRequest,
    BrowserObserveRequest,
    BrowserObserveResponse,
    BrowserSessionResponse,
    BrowserStartRequest,
    BrowserStatusResponse,
    BrowserTabRequest,
} from './types';

/**
 * Native browser automation bridge.
 */
export const browser = {
    status(): Promise<BrowserStatusResponse> {
        return invoke('browser_status');
    },
    start(request: BrowserStartRequest): Promise<BrowserSessionResponse> {
        return invoke('browser_start', { request });
    },
    discoverExisting(): Promise<BrowserExistingSession[]> {
        return invoke('browser_discover_existing');
    },
    connectExisting(
        request: BrowserConnectExistingRequest
    ): Promise<BrowserConnectExistingResponse> {
        return invoke('browser_connect_existing', { request });
    },
    stop(): Promise<BrowserSessionResponse> {
        return invoke('browser_stop');
    },
    navigate(request: BrowserNavigationRequest): Promise<BrowserSessionResponse> {
        return invoke('browser_navigate', { request });
    },
    back(request: BrowserTabRequest = {}): Promise<BrowserSessionResponse> {
        return invoke('browser_back', { request });
    },
    forward(request: BrowserTabRequest = {}): Promise<BrowserSessionResponse> {
        return invoke('browser_forward', { request });
    },
    reload(request: BrowserTabRequest = {}): Promise<BrowserSessionResponse> {
        return invoke('browser_reload', { request });
    },
    observe(request: BrowserObserveRequest): Promise<BrowserObserveResponse> {
        return invoke('browser_observe', { request });
    },
    act(request: BrowserActRequest): Promise<BrowserActResponse> {
        return invoke('browser_act', { request });
    },
} as const;
