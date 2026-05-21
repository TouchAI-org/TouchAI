// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 图像编解码工具。
//!
//! 提供 Windows GDI 返回的 BGRA 像素与标准 RGBA 之间的转换，
//! 以及 RGBA 像素 → PNG / JPEG Data URL 的一步编码能力。
//!
//! # 色彩空间说明
//!
//! - Windows HBITMAP 中像素排列为 BGRA（蓝-绿-红-Alpha）。
//! - image crate 及前端 <img> 标签使用 RGBA 排列。
//! - JPEG 不支持 Alpha 通道，编码前需通过 [rgba_to_rgb_over_white]
//!   将半透明像素合成到白色背景上。

use base64::Engine as _;
use image::{codecs::jpeg::JpegEncoder, ColorType, DynamicImage, ImageBuffer, ImageFormat, Rgba};
use std::io::Cursor;

/// 将 BGRA 像素序列转换为 RGBA。
///
/// Windows GDI 返回的位图数据为 BGRA 排列，需交换 R/B 通道后才能
/// 传入 image crate 或编码为标准 PNG/JPEG。
pub(super) fn bgra_to_rgba(bgra: &[u8]) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(bgra.len());
    for pixel in bgra.chunks_exact(4) {
        // BGRA → RGBA：交换 B(0) 和 R(2)，G(1) 和 A(3) 不变
        rgba.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
    }
    rgba
}

/// 将 RGBA 像素合成到白色背景并输出 RGB。
///
/// 使用标准 Alpha 混合公式：out = src * alpha + white * (1 - alpha)，
/// 以 u16 中间精度避免溢出。JPEG 编码前必须调用此函数去除 Alpha 通道。
pub(super) fn rgba_to_rgb_over_white(rgba: &[u8]) -> Vec<u8> {
    let mut rgb = Vec::with_capacity(rgba.len() / 4 * 3);
    for pixel in rgba.chunks_exact(4) {
        let alpha = u16::from(pixel[3]);
        let inv_alpha = 255_u16.saturating_sub(alpha);
        let red = ((u16::from(pixel[0]) * alpha) + (255 * inv_alpha)) / 255;
        let green = ((u16::from(pixel[1]) * alpha) + (255 * inv_alpha)) / 255;
        let blue = ((u16::from(pixel[2]) * alpha) + (255 * inv_alpha)) / 255;
        rgb.push(red as u8);
        rgb.push(green as u8);
        rgb.push(blue as u8);
    }
    rgb
}

/// 将 RGBA 像素编码为 PNG Data URL（data:image/png;base64,...）。
///
/// 用于图标编码——PNG 保留 Alpha 通道，适合叠加在任意背景上显示。
pub(super) fn encode_rgba_to_png_data_url(
    width: u32,
    height: u32,
    rgba_bytes: Vec<u8>,
) -> Result<String, String> {
    let image = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(width, height, rgba_bytes)
        .ok_or_else(|| "Failed to build RGBA buffer".to_string())?;
    let mut png_bytes = Vec::new();
    let mut cursor = Cursor::new(&mut png_bytes);
    DynamicImage::ImageRgba8(image)
        .write_to(&mut cursor, ImageFormat::Png)
        .map_err(|err| format!("Failed to encode icon to PNG: {}", err))?;

    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png_bytes)
    ))
}

/// 将 RGBA 像素编码为 JPEG Data URL（data:image/jpeg;base64,...）。
///
/// 用于缩略图编码——JPEG 体积更小，Alpha 通道会先合成到白色背景。
/// quality 会被 clamp 到 [20, 95] 范围。
pub(super) fn encode_rgba_to_jpeg_data_url(
    width: u32,
    height: u32,
    rgba_bytes: &[u8],
    quality: u8,
) -> Result<String, String> {
    let rgb_bytes = rgba_to_rgb_over_white(rgba_bytes);

    let mut jpeg_bytes = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut jpeg_bytes, quality.clamp(20, 95));
    encoder
        .encode(&rgb_bytes, width, height, ColorType::Rgb8.into())
        .map_err(|err| format!("Failed to encode thumbnail to JPEG: {}", err))?;

    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(jpeg_bytes)
    ))
}
