// Copyright (c) 2026. 千诚. Licensed under GPL v3

//! 系统托盘模块。

use image::{Rgba, RgbaImage};
use log::warn;
use std::sync::Mutex;
use tauri::{
    image::Image,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindowBuilder,
};

const TRAY_ID: &str = "touchai-tray";
const TRAY_TOOLTIP: &str = "TouchAI";
const MAX_BADGE_COUNT: u32 = 99;
const BADGE_MARGIN: u32 = 1;
const BADGE_DIAMETER: u32 = 19;
const GLYPH_WIDTH: u32 = 3;
const GLYPH_HEIGHT: u32 = 5;
const GLYPH_SCALE: u32 = 3;
const GLYPH_SPACING: u32 = 0;
const BADGE_FILL_COLOR: Rgba<u8> = Rgba([229, 115, 115, 176]);
const BADGE_TEXT_COLOR: Rgba<u8> = Rgba([255, 255, 255, 255]);

pub struct TrayBadgeRuntime {
    count: Mutex<u32>,
}

impl TrayBadgeRuntime {
    pub fn new() -> Self {
        Self {
            count: Mutex::new(0),
        }
    }

    pub fn set_count(&self, count: u32) {
        *self.count.lock().expect("tray badge runtime poisoned") = count;
    }

    pub fn count(&self) -> u32 {
        *self.count.lock().expect("tray badge runtime poisoned")
    }
}

impl Default for TrayBadgeRuntime {
    fn default() -> Self {
        Self::new()
    }
}

pub fn create_tray<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    let count = app
        .try_state::<TrayBadgeRuntime>()
        .map(|runtime| runtime.count())
        .unwrap_or(0);
    let icon = load_tray_icon_with_badge(count)?;

    let _tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip(tray_tooltip(count))
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Right,
                button_state: MouseButtonState::Up,
                position,
                ..
            } => {
                let app = tray.app_handle();
                if let Err(e) = show_tray_menu(app, position) {
                    warn!("Failed to show tray menu: {}", e);
                }
            }
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}

pub fn set_tray_badge_count<R: Runtime>(app: AppHandle<R>, count: u32) -> Result<(), String> {
    let runtime = app
        .try_state::<TrayBadgeRuntime>()
        .ok_or_else(|| "Tray badge runtime is not initialized".to_string())?;
    runtime.set_count(count);
    apply_tray_badge(&app, count)
}

pub fn clear_tray_badge<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    set_tray_badge_count(app, 0)
}

pub fn close_tray_menu<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("tray-menu") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 预加载托盘菜单窗口（隐藏状态），加速首次右键响应
pub fn preload_tray_menu<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    if app.get_webview_window("tray-menu").is_some() {
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(
        app,
        "tray-menu",
        WebviewUrl::App("/tray-menu".parse().unwrap()),
    )
    .inner_size(140.0, 134.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .focused(false)
    .build()?;

    crate::core::window::webview_defaults::apply_webview_runtime_defaults(&window)
        .map_err(std::io::Error::other)?;

    Ok(())
}

fn load_tray_icon_rgba() -> Result<RgbaImage, Box<dyn std::error::Error>> {
    let icon_bytes = include_bytes!("../../../../icons/32x32.png");

    let image = image::load_from_memory(icon_bytes)?;
    Ok(image.to_rgba8())
}

fn load_tray_icon_with_badge(count: u32) -> Result<Image<'static>, Box<dyn std::error::Error>> {
    let mut rgba = load_tray_icon_rgba()?;
    if count > 0 {
        render_badge_overlay(&mut rgba, count);
    }

    let (width, height) = rgba.dimensions();
    Ok(Image::new_owned(rgba.into_raw(), width, height))
}

fn tray_tooltip(count: u32) -> String {
    if count == 0 {
        return TRAY_TOOLTIP.to_string();
    }

    format!("{TRAY_TOOLTIP} ({count} pending status updates)")
}

fn apply_tray_badge<R: Runtime>(app: &AppHandle<R>, count: u32) -> Result<(), String> {
    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        let Some(tray) = app_handle.tray_by_id(TRAY_ID) else {
            return;
        };

        let icon = match load_tray_icon_with_badge(count) {
            Ok(icon) => icon,
            Err(error) => {
                warn!("Failed to load tray icon with badge: {}", error);
                return;
            }
        };

        if let Err(error) = tray.set_icon(Some(icon)) {
            warn!("Failed to update tray icon badge: {}", error);
        }

        if let Err(error) = tray.set_tooltip(Some(tray_tooltip(count))) {
            warn!("Failed to update tray tooltip: {}", error);
        }
    })
    .map_err(|error| error.to_string())
}

fn render_badge_overlay(image: &mut RgbaImage, count: u32) {
    let badge_text = badge_text(count);
    let text_width = badge_text_width(&badge_text);
    let left = image
        .width()
        .saturating_sub(BADGE_DIAMETER + BADGE_MARGIN)
        .min(image.width().saturating_sub(BADGE_DIAMETER));
    let top = BADGE_MARGIN.min(image.height().saturating_sub(BADGE_DIAMETER));

    draw_badge_circle(image, left, top, BADGE_DIAMETER, BADGE_FILL_COLOR);

    let text_x = left + (BADGE_DIAMETER.saturating_sub(text_width)) / 2;
    let text_y = top + (BADGE_DIAMETER.saturating_sub(GLYPH_HEIGHT * GLYPH_SCALE)) / 2;
    draw_badge_text(image, text_x, text_y, &badge_text, BADGE_TEXT_COLOR);
}

fn badge_text(count: u32) -> String {
    count.min(MAX_BADGE_COUNT).to_string()
}

fn badge_text_width(text: &str) -> u32 {
    let glyphs = text.chars().count() as u32;
    if glyphs == 0 {
        return 0;
    }

    glyphs * GLYPH_WIDTH * GLYPH_SCALE + (glyphs - 1) * GLYPH_SPACING
}

fn draw_badge_circle(image: &mut RgbaImage, left: u32, top: u32, diameter: u32, color: Rgba<u8>) {
    if diameter == 0 {
        return;
    }

    let radius = diameter as f32 / 2.0;
    let center_x = left as f32 + radius - 0.5;
    let center_y = top as f32 + radius - 0.5;
    let radius_squared = radius * radius;

    for y in top..top + diameter {
        for x in left..left + diameter {
            let px = x as f32 + 0.5;
            let py = y as f32 + 0.5;
            let dx = px - center_x;
            let dy = py - center_y;
            let inside = dx * dx + dy * dy <= radius_squared;

            if inside {
                image.put_pixel(x, y, color);
            }
        }
    }
}

fn draw_badge_text(image: &mut RgbaImage, x: u32, y: u32, text: &str, color: Rgba<u8>) {
    let mut cursor_x = x;
    for ch in text.chars() {
        if let Some(pattern) = glyph_pattern(ch) {
            for (row_index, row) in pattern.iter().enumerate() {
                for (col_index, pixel) in row.chars().enumerate() {
                    if pixel != '1' {
                        continue;
                    }

                    for dy in 0..GLYPH_SCALE {
                        for dx in 0..GLYPH_SCALE {
                            image.put_pixel(
                                cursor_x + col_index as u32 * GLYPH_SCALE + dx,
                                y + row_index as u32 * GLYPH_SCALE + dy,
                                color,
                            );
                        }
                    }
                }
            }
        }

        cursor_x += GLYPH_WIDTH * GLYPH_SCALE + GLYPH_SPACING;
    }
}

fn glyph_pattern(ch: char) -> Option<[&'static str; GLYPH_HEIGHT as usize]> {
    match ch {
        '0' => Some(["111", "101", "101", "101", "111"]),
        '1' => Some(["010", "110", "010", "010", "111"]),
        '2' => Some(["111", "001", "111", "100", "111"]),
        '3' => Some(["111", "001", "111", "001", "111"]),
        '4' => Some(["101", "101", "111", "001", "001"]),
        '5' => Some(["111", "100", "111", "001", "111"]),
        '6' => Some(["111", "100", "111", "101", "111"]),
        '7' => Some(["111", "001", "001", "001", "001"]),
        '8' => Some(["111", "101", "111", "101", "111"]),
        '9' => Some(["111", "101", "111", "001", "111"]),
        '+' => Some(["000", "010", "111", "010", "000"]),
        _ => None,
    }
}

fn show_tray_menu<R: Runtime>(
    app: &AppHandle<R>,
    click_position: PhysicalPosition<f64>,
) -> Result<(), Box<dyn std::error::Error>> {
    let menu_width = 140.0;
    let menu_height = 134.0;

    // 确保窗口存在（预加载或首次创建）
    let window = match app.get_webview_window("tray-menu") {
        Some(w) => w,
        None => {
            preload_tray_menu(app)?;
            app.get_webview_window("tray-menu")
                .ok_or("Failed to create tray-menu window")?
        }
    };

    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let logical_x = click_position.x / scale_factor;
    let logical_y = click_position.y / scale_factor;

    let (x, y) = if let Ok(Some(monitor)) = window.current_monitor() {
        let screen_size = monitor.size();
        let logical_screen_width = screen_size.width as f64 / scale_factor;
        let logical_screen_height = screen_size.height as f64 / scale_factor;

        let x = (logical_x - menu_width)
            .max(10.0)
            .min(logical_screen_width - menu_width - 10.0);
        let y = (logical_y - menu_height)
            .max(10.0)
            .min(logical_screen_height - menu_height - 10.0);

        (x, y)
    } else {
        let x = (logical_x - menu_width).max(10.0);
        let y = (logical_y - menu_height).max(10.0);
        (x, y)
    };

    window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }))?;
    window.show()?;
    window.set_focus()?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{badge_text, badge_text_width, render_badge_overlay, BADGE_FILL_COLOR};

    #[test]
    fn badge_text_caps_large_counts() {
        assert_eq!(badge_text(7), "7");
        assert_eq!(badge_text(42), "42");
        assert_eq!(badge_text(120), "99");
    }

    #[test]
    fn badge_text_width_expands_for_multiple_glyphs() {
        assert!(badge_text_width("8") < badge_text_width("18"));
        assert_eq!(badge_text_width("18"), badge_text_width("99"));
    }

    #[test]
    fn render_badge_overlay_draws_badge_pixels() {
        let mut image = image::RgbaImage::from_pixel(32, 32, image::Rgba([0, 0, 0, 0]));

        render_badge_overlay(&mut image, 5);

        let changed_pixels = image
            .pixels()
            .filter(|pixel| **pixel == BADGE_FILL_COLOR)
            .count();
        assert!(changed_pixels > 0);
    }

    #[test]
    fn render_badge_overlay_places_badge_in_top_right_corner() {
        let mut image = image::RgbaImage::from_pixel(32, 32, image::Rgba([0, 0, 0, 0]));

        render_badge_overlay(&mut image, 8);

        let mut top_right_pixels = 0;
        let mut bottom_right_pixels = 0;

        for x in 16..32 {
            for y in 0..16 {
                if *image.get_pixel(x, y) == BADGE_FILL_COLOR {
                    top_right_pixels += 1;
                }
            }
        }

        for x in 16..32 {
            for y in 16..32 {
                if *image.get_pixel(x, y) == BADGE_FILL_COLOR {
                    bottom_right_pixels += 1;
                }
            }
        }

        assert!(top_right_pixels > 0);
        assert!(top_right_pixels > bottom_right_pixels);
    }
}
