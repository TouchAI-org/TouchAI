// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 应用统一数据库运行时。

mod contract;
pub(crate) mod protocol;
pub(crate) mod runtime;
pub(crate) mod typed;

pub use protocol::types;

pub use runtime::DatabaseRuntime;
