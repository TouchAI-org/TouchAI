// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 内置工具原生能力。

mod bash;
#[cfg(target_os = "windows")]
mod process_utils;
mod registry;
mod types;

pub use bash::execute_bash;
pub use registry::{BashExecutionRegistry, BuiltInProcessExecutionRegistry};
pub use types::{BuiltInBashExecutionRequest, BuiltInBashExecutionResponse};
