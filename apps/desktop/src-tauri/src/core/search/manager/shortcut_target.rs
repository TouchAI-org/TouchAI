// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//快捷方式目标解析工具（Windows COM/Shell）。
//!
//输入 .lnk 路径，输出目标名称与目标路径，用于二阶段匹配中的目标字段补全。

use super::matching::normalize_search_term;
use std::{
    ffi::OsStr,
    os::windows::ffi::OsStrExt,
    path::{Path, PathBuf},
};
use windows::{
    core::{Interface, PCWSTR, PWSTR},
    Win32::{
        Foundation::RPC_E_CHANGED_MODE,
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile,
            CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READ,
        },
        UI::Shell::{
            Common::ITEMIDLIST, IShellItem, IShellLinkW, SHCreateItemFromParsingName,
            SHGetNameFromIDList, ShellLink, SIGDN_NORMALDISPLAY, SLGP_RAWPATH,
        },
    },
};

#[derive(Debug, Clone)]
pub(super) struct ShortcutTargetMetadata {
    pub(super) target_name: Option<String>,
    pub(super) target_path: Option<String>,
}

pub(super) unsafe fn resolve_shortcut_target_metadata(
    path: &Path,
) -> Option<ShortcutTargetMetadata> {
    // 该函数在 worker 线程中调用，按调用线程初始化 STA COM。
    let _com_guard = ComApartmentGuard::init_sta().ok()?;

    let shell_link =
        CoCreateInstance::<_, IShellLinkW>(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
    let persist_file = shell_link.cast::<IPersistFile>().ok()?;

    let wide_path = to_wide(&path.to_string_lossy());
    if persist_file
        .Load(PCWSTR(wide_path.as_ptr()), STGM_READ)
        .is_err()
    {
        return None;
    }

    let mut target_name: Option<String> = None;
    let mut target_path: Option<String> = None;

    if let Ok(target_pidl) = shell_link.GetIDList() {
        target_name = shell_display_name_from_pidl(target_pidl);
        CoTaskMemFree(Some(target_pidl.cast()));
    }

    let mut target_path_buffer = [0_u16; 2048];
    if shell_link
        .GetPath(
            &mut target_path_buffer,
            std::ptr::null_mut(),
            SLGP_RAWPATH.0 as u32,
        )
        .is_ok()
    {
        if let Some(target_path_text) = wide_buffer_to_string(&target_path_buffer) {
            target_path = normalize_search_term(&target_path_text);

            if target_name.is_none() {
                let target_path_buf = PathBuf::from(&target_path_text);
                target_name = target_path_buf
                    .file_stem()
                    .map(|stem| stem.to_string_lossy().to_string())
                    .and_then(|stem| normalize_search_term(&stem));

                if target_name.is_none() {
                    target_name = shell_display_name_from_path(&target_path_buf);
                }
            }
        }
    }

    if target_name.is_none() {
        let mut description_buffer = [0_u16; 1024];
        if shell_link.GetDescription(&mut description_buffer).is_ok() {
            target_name = wide_buffer_to_string(&description_buffer);
        }
    }

    if target_name.is_none() && target_path.is_none() {
        return None;
    }

    Some(ShortcutTargetMetadata {
        target_name,
        target_path,
    })
}

unsafe fn pwstr_to_string_and_free(ptr: PWSTR) -> Option<String> {
    if ptr.is_null() {
        return None;
    }

    let value = PCWSTR(ptr.0).to_string().ok();
    CoTaskMemFree(Some(ptr.0.cast()));
    value.and_then(|text| normalize_search_term(&text))
}

unsafe fn shell_display_name_from_path(path: &Path) -> Option<String> {
    let wide_path = to_wide(&path.to_string_lossy());
    let shell_item: IShellItem =
        SHCreateItemFromParsingName(PCWSTR(wide_path.as_ptr()), None).ok()?;
    let display_name = shell_item.GetDisplayName(SIGDN_NORMALDISPLAY).ok()?;
    pwstr_to_string_and_free(display_name)
}

unsafe fn shell_display_name_from_pidl(pidl: *const ITEMIDLIST) -> Option<String> {
    if pidl.is_null() {
        return None;
    }
    let display_name = SHGetNameFromIDList(pidl, SIGDN_NORMALDISPLAY).ok()?;
    pwstr_to_string_and_free(display_name)
}

fn wide_buffer_to_string(buffer: &[u16]) -> Option<String> {
    let end = buffer
        .iter()
        .position(|ch| *ch == 0)
        .unwrap_or(buffer.len());
    if end == 0 {
        return None;
    }
    let text = String::from_utf16_lossy(&buffer[..end]);
    normalize_search_term(&text)
}

struct ComApartmentGuard {
    /// true 表示当前线程本次调用成功初始化了 COM，需要在 drop 时反初始化。
    initialized: bool,
}

impl ComApartmentGuard {
    unsafe fn init_sta() -> Result<Self, String> {
        // 期望 STA；若线程已在其他模型下初始化（RPC_E_CHANGED_MODE），沿用现状继续执行。
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        if hr.is_ok() {
            return Ok(Self { initialized: true });
        }

        if hr == RPC_E_CHANGED_MODE {
            return Ok(Self { initialized: false });
        }

        Err(format!("Failed to initialize COM: {:?}", hr))
    }
}

impl Drop for ComApartmentGuard {
    fn drop(&mut self) {
        if self.initialized {
            unsafe { CoUninitialize() };
        }
    }
}

fn to_wide(path: &str) -> Vec<u16> {
    OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}
