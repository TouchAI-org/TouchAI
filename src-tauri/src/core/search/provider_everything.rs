// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Everything SDK 访问层。
//!
//! 负责把 Rust 调用转换为 Everything C API 请求，并标准化错误语义。

use std::{ffi::OsStr, os::windows::ffi::OsStrExt};

const EVERYTHING_ERROR_IPC: u32 = 2;
const EVERYTHING_SORT_NAME_ASCENDING: u32 = 1;
const EVERYTHING_REQUEST_FILE_NAME: u32 = 0x0000_0001;
const EVERYTHING_REQUEST_PATH: u32 = 0x0000_0002;
const EVERYTHING_QUERY_ALL_RESULTS: u32 = 0xffff_ffff;
const EVERYTHING_SHORTCUT_SEARCH_TERM: &str = "ext:lnk";

/// Everything 查询错误。
#[derive(Debug)]
pub(crate) struct EverythingError {
    code: u32,
    /// 面向上层的可读错误信息。
    pub(crate) message: String,
}

impl EverythingError {
    /// 判断是否属于 IPC 不可用（Everything 未运行或不可达）。
    pub(crate) fn is_ipc_unavailable(&self) -> bool {
        self.code == EVERYTHING_ERROR_IPC
    }
}

/// Everything 查询客户端（轻量无状态包装）。
pub(crate) struct EverythingClient;

impl EverythingClient {
    /// 创建客户端实例。
    pub(crate) fn new() -> Self {
        Self
    }

    /// 查询 Everything 数据库是否完成加载。
    pub(crate) fn is_db_loaded(&mut self) -> Result<bool, EverythingError> {
        unsafe {
            let loaded = Everything_IsDBLoaded() != 0;
            let error_code = Everything_GetLastError();
            if loaded {
                return Ok(true);
            }
            if error_code == 0 {
                return Ok(false);
            }
            Err(EverythingError {
                code: error_code,
                message: format!("Everything_IsDBLoaded failed, code={}", error_code),
            })
        }
    }

    pub(crate) fn query_paths(
        &mut self,
        search_text: &str,
        max_results: u32,
    ) -> Result<Vec<String>, EverythingError> {
        unsafe {
            // 每次查询前重置 SDK 内部状态，避免沿用上次参数。
            Everything_Reset();
            let search_wide = to_wide(search_text);
            Everything_SetSearchW(search_wide.as_ptr());
            Everything_SetRequestFlags(EVERYTHING_REQUEST_FILE_NAME | EVERYTHING_REQUEST_PATH);
            Everything_SetSort(EVERYTHING_SORT_NAME_ASCENDING);
            Everything_SetMatchPath(0);
            Everything_SetMatchCase(0);
            Everything_SetRegex(0);
            Everything_SetMax(max_results);

            if Everything_QueryW(1) == 0 {
                let error_code = Everything_GetLastError();
                // 失败后也重置，防止下次查询受污染。
                Everything_Reset();
                return Err(EverythingError {
                    code: error_code,
                    message: format!("Everything_QueryW failed, code={}", error_code),
                });
            }

            let result_count = Everything_GetNumResults();
            let mut results = Vec::with_capacity(result_count as usize);
            // 复用缓冲区以减少每条结果的分配开销。
            let mut buffer = vec![0_u16; 32768];

            for index in 0..result_count {
                let copied = Everything_GetResultFullPathNameW(
                    index,
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                );
                if copied == 0 {
                    continue;
                }
                let end = buffer
                    .iter()
                    .position(|ch| *ch == 0)
                    .unwrap_or_else(|| (copied as usize).min(buffer.len()));
                if end == 0 {
                    continue;
                }
                let path = String::from_utf16_lossy(&buffer[..end]);
                if !path.trim().is_empty() {
                    results.push(path);
                }
            }

            Everything_Reset();
            Ok(results)
        }
    }

    /// 查询系统中所有快捷方式路径。
    pub(crate) fn query_lnk_paths(&mut self) -> Result<Vec<String>, EverythingError> {
        self.query_paths(
            EVERYTHING_SHORTCUT_SEARCH_TERM,
            EVERYTHING_QUERY_ALL_RESULTS,
        )
    }
}

#[link(name = "everything_sdk", kind = "static")]
unsafe extern "system" {
    fn Everything_Reset();
    fn Everything_SetSearchW(lpString: *const u16);
    fn Everything_SetRequestFlags(dwRequestFlags: u32);
    fn Everything_SetSort(dwSort: u32);
    fn Everything_SetMatchPath(bEnable: i32);
    fn Everything_SetMatchCase(bEnable: i32);
    fn Everything_SetRegex(bEnable: i32);
    fn Everything_SetMax(dwMax: u32);
    fn Everything_QueryW(bWait: i32) -> i32;
    fn Everything_GetNumResults() -> u32;
    fn Everything_GetResultFullPathNameW(
        dwIndex: u32,
        wbuf: *mut u16,
        wbuf_size_in_wchars: u32,
    ) -> u32;
    fn Everything_GetLastError() -> u32;
    fn Everything_IsDBLoaded() -> i32;
}

fn to_wide(path: &str) -> Vec<u16> {
    OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}
