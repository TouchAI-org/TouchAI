// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

use crate::core::app_use::{
    AppUseActRequest, AppUseActResponse, AppUseAuthorizeActRequest, AppUseAuthorizeActResponse,
    AppUseObserveRequest, AppUseObserveResponse, AppUseRuntime, AppUseSessionRequest,
    AppUseSessionResponse,
};
use tauri::State;

#[tauri::command]
pub fn app_use_session(
    request: AppUseSessionRequest,
    runtime: State<'_, AppUseRuntime>,
) -> Result<AppUseSessionResponse, String> {
    Ok(runtime.session(request))
}

#[tauri::command]
pub fn app_use_observe(
    request: AppUseObserveRequest,
    runtime: State<'_, AppUseRuntime>,
) -> Result<AppUseObserveResponse, String> {
    Ok(runtime.observe(request))
}

#[tauri::command]
pub fn app_use_authorize_act(
    request: AppUseAuthorizeActRequest,
    runtime: State<'_, AppUseRuntime>,
) -> Result<AppUseAuthorizeActResponse, String> {
    Ok(runtime.authorize_act(request))
}

#[tauri::command]
pub fn app_use_act(
    request: AppUseActRequest,
    runtime: State<'_, AppUseRuntime>,
) -> Result<AppUseActResponse, String> {
    Ok(runtime.act(request))
}
