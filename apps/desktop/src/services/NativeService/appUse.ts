import { invoke } from '@tauri-apps/api/core';

import type {
    AppUseNativeActRequest,
    AppUseNativeActResponse,
    AppUseNativeAuthorizeActRequest,
    AppUseNativeAuthorizeActResponse,
    AppUseNativeObserveRequest,
    AppUseNativeObserveResponse,
    AppUseNativeSessionRequest,
    AppUseNativeSessionResponse,
} from './types';

export const appUse = {
    session(request: AppUseNativeSessionRequest): Promise<AppUseNativeSessionResponse> {
        return invoke('app_use_session', { request });
    },
    observe(request: AppUseNativeObserveRequest): Promise<AppUseNativeObserveResponse> {
        return invoke('app_use_observe', { request });
    },
    authorizeAct(
        request: AppUseNativeAuthorizeActRequest
    ): Promise<AppUseNativeAuthorizeActResponse> {
        return invoke('app_use_authorize_act', { request });
    },
    act(request: AppUseNativeActRequest): Promise<AppUseNativeActResponse> {
        return invoke('app_use_act', { request });
    },
} as const;
