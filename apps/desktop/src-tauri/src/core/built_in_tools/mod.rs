// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 内置工具原生能力。

mod bash;
mod computer;
#[cfg(target_os = "windows")]
mod process_utils;
mod registry;
mod types;

pub use bash::execute_bash;
pub use computer::{computer_act, computer_observe, computer_session, ComputerRuntime};
pub use registry::{BashExecutionRegistry, BuiltInProcessExecutionRegistry};
pub use types::{
    BuiltInBashExecutionRequest, BuiltInBashExecutionResponse, ComputerActionRequest,
    ComputerActionResponse, ComputerObservationRequest, ComputerObservationResponse,
    ComputerSessionRequest, ComputerSessionResponse,
};
