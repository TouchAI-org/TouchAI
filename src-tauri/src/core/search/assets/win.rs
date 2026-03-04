// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Windows Shell 图标与缩略图提取。
//!
//! 封装两套 Windows API 来获取文件的视觉表示：
//!
//! - SHGetFileInfoW（快速路径）：从系统图标缓存中查找，速度快但尺寸有限
//!   （16×16 / 32×32 / 48×48）。
//! - IShellItemImageFactory（高质量路径）：按需渲染任意尺寸的图标或缩略图，
//!   需要 COM 初始化，速度较慢但质量更高。
//!
//! # COM 线程模型
//!
//! Shell API 要求 STA（单线程套间），由 [ComApartmentGuard] 管理生命周期：
//! 构造时调用 CoInitializeEx(STA)，Drop 时调用 CoUninitialize。
//! 若线程已经处于 MTA 模式（RPC_E_CHANGED_MODE），则跳过初始化，不调用反初始化。
//!
//! # GDI 资源管理
//!
//! 所有 HBITMAP、HICON、HDC 均在使用后立即释放，
//! 通过闭包 + 手动清理模式确保即使提取失败也不会泄漏。

use super::{
    cache::thumbnail_jpeg_quality,
    codec::{bgra_to_rgba, encode_rgba_to_jpeg_data_url, encode_rgba_to_png_data_url},
};
use std::{ffi::OsStr, os::windows::ffi::OsStrExt, path::Path};
use windows::{
    core::{Error as WindowsError, PCWSTR},
    Win32::{
        Foundation::{HANDLE, RPC_E_CHANGED_MODE, SIZE},
        Graphics::Gdi::{
            CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDIBits, GetObjectW,
            SelectObject, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP,
            HBRUSH, HDC, HGDIOBJ, RGBQUAD,
        },
        Storage::FileSystem::FILE_ATTRIBUTE_NORMAL,
        System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
        UI::{
            Shell::{
                IShellItemImageFactory, SHCreateItemFromParsingName, SHGetFileInfoW, SHFILEINFOW,
                SHGFI_FLAGS, SHGFI_ICON, SHGFI_LARGEICON, SHGFI_SHELLICONSIZE, SHGFI_SMALLICON,
                SHGFI_USEFILEATTRIBUTES, SIIGBF, SIIGBF_BIGGERSIZEOK, SIIGBF_ICONONLY,
                SIIGBF_INCACHEONLY, SIIGBF_THUMBNAILONLY,
            },
            WindowsAndMessaging::{DestroyIcon, DrawIconEx, DI_NORMAL, HICON},
        },
    },
};

// ---------------------------------------------------------------------------
// HBITMAP / HICON → Data URL 底层转换
// ---------------------------------------------------------------------------

/// 从 HBITMAP 中提取 RGBA 像素数据。
///
/// 创建兼容 DC 后通过 GetDIBits 读取 32 位 BGRA 像素，
/// 再经 [bgra_to_rgba] 转为 RGBA。无论成功与否都会释放 DC 和 HBITMAP。
///
/// # Safety
///
/// hbitmap 必须是有效的 GDI 位图句柄。
unsafe fn extract_hbitmap_rgba(hbitmap: HBITMAP) -> Result<(u32, u32, Vec<u8>), String> {
    if hbitmap.is_invalid() {
        return Err("Invalid HBITMAP".to_string());
    }

    let hdc = CreateCompatibleDC(HDC::default());
    if hdc.is_invalid() {
        let _ = DeleteObject(HGDIOBJ(hbitmap.0));
        return Err("Failed to create compatible DC".to_string());
    }

    // 闭包内完成像素读取，外层统一释放 GDI 资源
    let result = (|| {
        let mut bitmap = BITMAP::default();
        let object_result = GetObjectW(
            HGDIOBJ(hbitmap.0),
            std::mem::size_of::<BITMAP>() as i32,
            Some((&mut bitmap as *mut BITMAP).cast()),
        );
        if object_result == 0 {
            return Err("Failed to read HBITMAP metadata".to_string());
        }

        let width = bitmap.bmWidth.max(1);
        let height = bitmap.bmHeight.abs().max(1);
        // top-down DIB：biHeight 取负值，像素从左上角开始
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height, // top-down DIB
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0 as u32,
                ..Default::default()
            },
            bmiColors: [RGBQUAD::default(); 1],
        };

        let total_bytes = (width as usize) * (height as usize) * 4;
        let mut bgra_bytes = vec![0_u8; total_bytes];
        let copied_lines = GetDIBits(
            hdc,
            hbitmap,
            0,
            height as u32,
            Some(bgra_bytes.as_mut_ptr().cast()),
            &mut bmi,
            DIB_RGB_COLORS,
        );
        if copied_lines == 0 {
            return Err("Failed to read bitmap pixels".to_string());
        }

        Ok((width as u32, height as u32, bgra_to_rgba(&bgra_bytes)))
    })();

    // 无论成功与否都释放 GDI 资源
    let _ = DeleteDC(hdc);
    let _ = DeleteObject(HGDIOBJ(hbitmap.0));
    result
}

/// 将 HBITMAP 转换为 PNG Data URL（保留 Alpha 通道）。
///
/// # Safety
///
/// hbitmap 必须是有效的 GDI 位图句柄，调用后句柄将被释放。
unsafe fn hbitmap_to_data_url(hbitmap: HBITMAP) -> Result<String, String> {
    let (width, height, rgba_bytes) = extract_hbitmap_rgba(hbitmap)?;
    encode_rgba_to_png_data_url(width, height, rgba_bytes)
}

/// 将 HBITMAP 转换为 JPEG Data URL（缩略图专用，Alpha 合成到白底）。
///
/// # Safety
///
/// hbitmap 必须是有效的 GDI 位图句柄，调用后句柄将被释放。
unsafe fn hbitmap_to_thumbnail_data_url(hbitmap: HBITMAP) -> Result<String, String> {
    let (width, height, rgba_bytes) = extract_hbitmap_rgba(hbitmap)?;
    encode_rgba_to_jpeg_data_url(width, height, &rgba_bytes, thumbnail_jpeg_quality())
}

/// 将 HICON 绘制到内存位图后转换为 PNG Data URL。
///
/// 创建指定尺寸的 32 位 DIB，用 DrawIconEx 绘制图标，
/// 读取像素后转为 RGBA 再编码。所有 GDI 资源在函数返回前释放。
///
/// # Safety
///
/// hicon 必须是有效的图标句柄，调用后句柄将被销毁。
unsafe fn hicon_to_data_url(hicon: HICON, size: u32) -> Result<String, String> {
    let width = size.max(16) as i32;
    let height = size.max(16) as i32;
    let mut bits_ptr: *mut core::ffi::c_void = std::ptr::null_mut();

    let hdc = CreateCompatibleDC(HDC::default());
    if hdc.is_invalid() {
        let _ = DestroyIcon(hicon);
        return Err("Failed to create compatible DC".to_string());
    }

    // 创建 32 位 top-down DIB 作为绘制目标
    let bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height, // top-down DIB
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0 as u32,
            ..Default::default()
        },
        bmiColors: [RGBQUAD::default(); 1],
    };

    let hbitmap: HBITMAP = CreateDIBSection(
        hdc,
        &bmi,
        DIB_RGB_COLORS,
        &mut bits_ptr as *mut *mut core::ffi::c_void,
        HANDLE::default(),
        0,
    )
    .map_err(|err| format!("Failed to create DIB section: {}", err))?;
    if hbitmap.is_invalid() || bits_ptr.is_null() {
        let _ = DeleteDC(hdc);
        let _ = DestroyIcon(hicon);
        return Err("Failed to create DIB section".to_string());
    }

    // 将 DIB 选入 DC，绘制图标，然后直接从 bits_ptr 读取像素
    let old_obj: HGDIOBJ = SelectObject(hdc, HGDIOBJ(hbitmap.0));
    let draw_ok = DrawIconEx(
        hdc,
        0,
        0,
        hicon,
        width,
        height,
        0,
        HBRUSH::default(),
        DI_NORMAL,
    )
    .is_ok();

    let result = if draw_ok {
        let total_bytes = (width as usize) * (height as usize) * 4;
        let bgra_bytes = std::slice::from_raw_parts(bits_ptr as *const u8, total_bytes);
        let rgba_bytes = bgra_to_rgba(bgra_bytes);

        encode_rgba_to_png_data_url(width as u32, height as u32, rgba_bytes)
    } else {
        Err("Failed to draw icon".to_string())
    };

    // 释放所有 GDI 资源
    let _ = SelectObject(hdc, old_obj);
    let _ = DeleteObject(HGDIOBJ(hbitmap.0));
    let _ = DeleteDC(hdc);
    let _ = DestroyIcon(hicon);
    result
}

// ---------------------------------------------------------------------------
// COM 套间管理
// ---------------------------------------------------------------------------

/// COM STA 初始化守卫，Drop 时自动调用 CoUninitialize。
///
/// 若当前线程已处于 MTA 模式（RPC_E_CHANGED_MODE），则不初始化也不反初始化，
/// 避免干扰已有的 COM 环境。
struct ComApartmentGuard {
    /// 是否由本守卫执行了 CoInitializeEx，true 时 Drop 会调用反初始化。
    initialized: bool,
}

impl ComApartmentGuard {
    /// 以 STA 模式初始化 COM 套间。
    ///
    /// # Safety
    ///
    /// 调用方须确保当前线程不在 COM 回调中。
    unsafe fn init_sta() -> Result<Self, String> {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        if hr.is_ok() {
            return Ok(Self { initialized: true });
        }

        // 线程已处于 MTA 模式，跳过初始化
        if hr == RPC_E_CHANGED_MODE {
            return Ok(Self { initialized: false });
        }

        Err(format!(
            "Failed to initialize COM: {}",
            WindowsError::from(hr)
        ))
    }
}

impl Drop for ComApartmentGuard {
    fn drop(&mut self) {
        if self.initialized {
            unsafe { CoUninitialize() };
        }
    }
}

// ---------------------------------------------------------------------------
// 公开提取 API
// ---------------------------------------------------------------------------

/// 通过 IShellItemImageFactory 提取快捷方式图标。
///
/// 先尝试 Shell 缓存中的图标（SIIGBF_INCACHEONLY），
/// 若未命中再触发实际渲染。返回 PNG Data URL。
///
/// # Safety
///
/// 需要 COM STA 环境，由 [ComApartmentGuard] 保证。
pub(super) unsafe fn shortcut_icon_data_url_shell_item(
    path: &str,
    size: u32,
) -> Result<Option<String>, String> {
    let _com_guard = ComApartmentGuard::init_sta()?;
    let wide_path = to_wide(path);
    let image_factory: IShellItemImageFactory =
        SHCreateItemFromParsingName(PCWSTR(wide_path.as_ptr()), None)
            .map_err(|err| format!("Failed to create image factory: {}", err))?;

    let request_edge = size.clamp(16, 96) as i32;
    let request_size = SIZE {
        cx: request_edge,
        cy: request_edge,
    };
    // 优先从 Shell 缓存获取，避免磁盘 IO
    let cache_only_flags: SIIGBF = SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK | SIIGBF_INCACHEONLY;
    if let Ok(hbitmap) = image_factory.GetImage(request_size, cache_only_flags) {
        let data_url = hbitmap_to_data_url(hbitmap)?;
        return Ok(Some(data_url));
    }

    // 缓存未命中，触发实际渲染
    let flags: SIIGBF = SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK;
    let hbitmap = image_factory
        .GetImage(request_size, flags)
        .map_err(|err| format!("Failed to get shell item image: {}", err))?;

    let data_url = hbitmap_to_data_url(hbitmap)?;
    Ok(Some(data_url))
}

/// 通过 IShellItemImageFactory 提取图片缩略图。
///
/// 与图标提取类似，但使用 SIIGBF_THUMBNAILONLY 标志请求文件内容缩略图，
/// 编码为 JPEG Data URL 以减小传输体积。
///
/// # Safety
///
/// 需要 COM STA 环境，由 [ComApartmentGuard] 保证。
pub(super) unsafe fn image_thumbnail_data_url_shell_item(
    path: &str,
    size: u32,
) -> Result<Option<String>, String> {
    let _com_guard = ComApartmentGuard::init_sta()?;
    let wide_path = to_wide(path);
    let image_factory: IShellItemImageFactory =
        SHCreateItemFromParsingName(PCWSTR(wide_path.as_ptr()), None)
            .map_err(|err| format!("Failed to create thumbnail factory: {}", err))?;

    let request_edge = size.clamp(24, 128) as i32;
    let request_size = SIZE {
        cx: request_edge,
        cy: request_edge,
    };

    // 优先从 Shell 缩略图缓存获取
    let cache_only_flags: SIIGBF = SIIGBF_THUMBNAILONLY | SIIGBF_BIGGERSIZEOK | SIIGBF_INCACHEONLY;
    if let Ok(hbitmap) = image_factory.GetImage(request_size, cache_only_flags) {
        let data_url = hbitmap_to_thumbnail_data_url(hbitmap)?;
        return Ok(Some(data_url));
    }

    // 缓存未命中，触发实际渲染；渲染失败时返回 None（不报错）
    let flags: SIIGBF = SIIGBF_THUMBNAILONLY | SIIGBF_BIGGERSIZEOK;
    match image_factory.GetImage(request_size, flags) {
        Ok(hbitmap) => {
            let data_url = hbitmap_to_thumbnail_data_url(hbitmap)?;
            Ok(Some(data_url))
        }
        Err(_) => Ok(None),
    }
}

/// 判断文件是否为 .lnk 快捷方式。
pub(super) fn is_shortcut_file(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("lnk"))
}

/// 根据图标尺寸选择 SHGetFileInfoW 的 flag 组合。
///
/// - ≤ 20px → 小图标（16×16）
/// - ≥ 40px → 大图标 + Shell 尺寸（48×48）
/// - 其他 → 大图标（32×32）
fn quick_icon_flags(size: u32) -> SHGFI_FLAGS {
    if size <= 20 {
        SHGFI_ICON | SHGFI_SMALLICON
    } else if size >= 40 {
        SHGFI_ICON | SHGFI_LARGEICON | SHGFI_SHELLICONSIZE
    } else {
        SHGFI_ICON | SHGFI_LARGEICON
    }
}

/// 通过 SHGetFileInfoW 获取文件实际路径对应的图标（快速路径）。
///
/// 直接从系统图标缓存获取，无需 COM 初始化，速度最快。
/// 返回 PNG Data URL，失败返回 Ok(None)。
pub(super) fn shortcut_icon_data_url_fallback(
    path: &str,
    size: u32,
) -> Result<Option<String>, String> {
    let wide_path = to_wide(path);
    let mut file_info = SHFILEINFOW::default();
    let flags = quick_icon_flags(size);

    let result = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide_path.as_ptr()),
            Default::default(),
            Some(&mut file_info as *mut SHFILEINFOW),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            flags,
        )
    };

    if result == 0 || file_info.hIcon.is_invalid() {
        return Ok(None);
    }

    let data_url = unsafe { hicon_to_data_url(file_info.hIcon, size)? };
    Ok(Some(data_url))
}

/// 通过扩展名查询系统关联的文件类型图标。
///
/// 使用 SHGFI_USEFILEATTRIBUTES 标志，不需要文件实际存在，
/// 仅根据扩展名从注册表中查找关联图标。
pub(super) fn shortcut_icon_data_url_by_extension(
    path: &str,
    size: u32,
) -> Result<Option<String>, String> {
    let extension = Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::trim)
        .filter(|ext| !ext.is_empty());
    let Some(extension) = extension else {
        return Ok(None);
    };

    // 构造 ".ext" 格式用于查询
    let extension_query = format!(".{}", extension);
    let wide_query = to_wide(&extension_query);
    let mut file_info = SHFILEINFOW::default();
    let flags = quick_icon_flags(size) | SHGFI_USEFILEATTRIBUTES;

    let result = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide_query.as_ptr()),
            FILE_ATTRIBUTE_NORMAL,
            Some(&mut file_info as *mut SHFILEINFOW),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            flags,
        )
    };

    if result == 0 || file_info.hIcon.is_invalid() {
        return Ok(None);
    }

    let data_url = unsafe { hicon_to_data_url(file_info.hIcon, size)? };
    Ok(Some(data_url))
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/// 将 UTF-8 字符串转为以 null 结尾的 UTF-16 宽字符序列，供 Win32 API 使用。
fn to_wide(path: &str) -> Vec<u16> {
    OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}
