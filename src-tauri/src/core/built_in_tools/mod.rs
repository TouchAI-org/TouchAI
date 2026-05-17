// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 内置工具原生能力。

mod bash;
mod process_utils;
mod registry;
mod ripgrep;
mod types;

mod embedded_ripgrep {
    include!(concat!(env!("OUT_DIR"), "/ripgrep-binary.rs"));
}

pub use bash::execute_bash;
pub use registry::{BashExecutionRegistry, BuiltInProcessExecutionRegistry};
pub use types::{BuiltInBashExecutionRequest, BuiltInBashExecutionResponse};
