// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 应用统一数据库运行时。

mod contract;
mod protocol;
mod runtime;

pub use protocol::types;

pub(crate) use runtime::relocation::remap as remap_storage_paths;
pub use runtime::DatabaseRuntime;
