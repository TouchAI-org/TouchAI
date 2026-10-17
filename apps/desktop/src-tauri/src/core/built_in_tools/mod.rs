// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 内置工具原生能力。

mod bash;
#[cfg(target_os = "windows")]
mod process_utils;
mod registry;
mod types;

pub use bash::execute_bash;
pub use registry::{BashExecutionRegistry, BuiltInProcessExecutionRegistry};
pub use types::{
    BuiltInBashEvent, BuiltInBashExecutionRequest, BuiltInBashExecutionResponse,
    BuiltInBashStreamChunk,
};

pub fn prewarm_bash_runtime() -> bool {
    crate::core::system::bundled::get_bundled_rtk_directory().is_some()
}
