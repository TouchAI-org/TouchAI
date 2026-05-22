// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

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
const INDICATOR_MARGIN: u32 = 2;
const INDICATOR_OUTER_DIAMETER: u32 = 12;
const INDICATOR_INNER_DIAMETER: u32 = 8;
const INDICATOR_RING_COLOR: Rgba<u8> = Rgba([255, 255, 255, 232]);
const COMPLETED_INDICATOR_COLOR: Rgba<u8> = Rgba([22, 163, 74, 255]);
const FAILED_INDICATOR_COLOR: Rgba<u8> = Rgba([220, 38, 38, 255]);
const WAITING_INDICATOR_COLOR: Rgba<u8> = Rgba([234, 179, 8, 255]);

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrayStatusIndicator {
    Completed,
    Failed,
    WaitingApproval,
}

pub struct TrayStatusRuntime {
    status: Mutex<Option<TrayStatusIndicator>>,
}

impl TrayStatusRuntime {
    pub fn new() -> Self {
        Self {
            status: Mutex::new(None),
        }
    }

    pub fn set_status(&self, status: Option<TrayStatusIndicator>) {
        *self.status.lock().expect("tray status runtime poisoned") = status;
    }

    pub fn status(&self) -> Option<TrayStatusIndicator> {
        *self.status.lock().expect("tray status runtime poisoned")
    }
}

impl Default for TrayStatusRuntime {
    fn default() -> Self {
        Self::new()
    }
}

pub fn create_tray<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    let status = app
        .try_state::<TrayStatusRuntime>()
        .and_then(|runtime| runtime.status());
    let icon = load_tray_icon_with_indicator(status)?;

    let _tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip(tray_tooltip(status))
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Right,
                button_state: MouseButtonState::Up,
                position,
                ..
            } => {
                let app = tray.app_handle();
                if let Err(error) = show_tray_menu(app, position) {
                    warn!("Failed to show tray menu: {}", error);
                }
            }
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => {
                let app = tray.app_handle().clone();
                if let Err(error) = crate::core::window::show_search_window(app) {
                    warn!("Failed to restore search window from tray icon: {}", error);
                }
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}

pub fn set_tray_status_indicator<R: Runtime>(
    app: AppHandle<R>,
    status: TrayStatusIndicator,
) -> Result<(), String> {
    let runtime = app
        .try_state::<TrayStatusRuntime>()
        .ok_or_else(|| "Tray status runtime is not initialized".to_string())?;
    runtime.set_status(Some(status));
    apply_tray_status(&app, Some(status))
}

pub fn clear_tray_status_indicator<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let runtime = app
        .try_state::<TrayStatusRuntime>()
        .ok_or_else(|| "Tray status runtime is not initialized".to_string())?;
    runtime.set_status(None);
    apply_tray_status(&app, None)
}

pub fn close_tray_menu<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("tray-menu") {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

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

fn load_tray_icon_with_indicator(
    status: Option<TrayStatusIndicator>,
) -> Result<Image<'static>, Box<dyn std::error::Error>> {
    let mut rgba = load_tray_icon_rgba()?;
    if let Some(status) = status {
        render_status_indicator(&mut rgba, status);
    }

    let (width, height) = rgba.dimensions();
    Ok(Image::new_owned(rgba.into_raw(), width, height))
}

fn tray_tooltip(status: Option<TrayStatusIndicator>) -> String {
    match status {
        Some(TrayStatusIndicator::Completed) => format!("{TRAY_TOOLTIP} (completed)"),
        Some(TrayStatusIndicator::Failed) => format!("{TRAY_TOOLTIP} (failed)"),
        Some(TrayStatusIndicator::WaitingApproval) => {
            format!("{TRAY_TOOLTIP} (waiting approval)")
        }
        None => TRAY_TOOLTIP.to_string(),
    }
}

fn apply_tray_status<R: Runtime>(
    app: &AppHandle<R>,
    status: Option<TrayStatusIndicator>,
) -> Result<(), String> {
    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        let Some(tray) = app_handle.tray_by_id(TRAY_ID) else {
            return;
        };

        let icon = match load_tray_icon_with_indicator(status) {
            Ok(icon) => icon,
            Err(error) => {
                warn!("Failed to load tray icon with status indicator: {}", error);
                return;
            }
        };

        if let Err(error) = tray.set_icon(Some(icon)) {
            warn!("Failed to update tray icon status indicator: {}", error);
        }

        if let Err(error) = tray.set_tooltip(Some(tray_tooltip(status))) {
            warn!("Failed to update tray tooltip: {}", error);
        }
    })
    .map_err(|error| error.to_string())
}

fn render_status_indicator(image: &mut RgbaImage, status: TrayStatusIndicator) {
    let outer_left = image
        .width()
        .saturating_sub(INDICATOR_OUTER_DIAMETER + INDICATOR_MARGIN);
    let outer_top = INDICATOR_MARGIN.min(image.height().saturating_sub(INDICATOR_OUTER_DIAMETER));
    let inner_offset = (INDICATOR_OUTER_DIAMETER - INDICATOR_INNER_DIAMETER) / 2;
    let inner_left = outer_left + inner_offset;
    let inner_top = outer_top + inner_offset;

    draw_filled_circle(
        image,
        outer_left,
        outer_top,
        INDICATOR_OUTER_DIAMETER,
        INDICATOR_RING_COLOR,
    );
    draw_filled_circle(
        image,
        inner_left,
        inner_top,
        INDICATOR_INNER_DIAMETER,
        indicator_color(status),
    );
}

fn indicator_color(status: TrayStatusIndicator) -> Rgba<u8> {
    match status {
        TrayStatusIndicator::Completed => COMPLETED_INDICATOR_COLOR,
        TrayStatusIndicator::Failed => FAILED_INDICATOR_COLOR,
        TrayStatusIndicator::WaitingApproval => WAITING_INDICATOR_COLOR,
    }
}

fn draw_filled_circle(image: &mut RgbaImage, left: u32, top: u32, diameter: u32, color: Rgba<u8>) {
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
            if dx * dx + dy * dy <= radius_squared {
                image.put_pixel(x, y, color);
            }
        }
    }
}

fn show_tray_menu<R: Runtime>(
    app: &AppHandle<R>,
    click_position: PhysicalPosition<f64>,
) -> Result<(), Box<dyn std::error::Error>> {
    let menu_width = 140.0;
    let menu_height = 134.0;

    let window = match app.get_webview_window("tray-menu") {
        Some(window) => window,
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
    use super::{
        indicator_color, render_status_indicator, TrayStatusIndicator, COMPLETED_INDICATOR_COLOR,
    };

    #[test]
    fn indicator_color_matches_completed_status() {
        assert_eq!(
            indicator_color(TrayStatusIndicator::Completed),
            COMPLETED_INDICATOR_COLOR
        );
    }

    #[test]
    fn render_status_indicator_draws_status_pixels() {
        let mut image = image::RgbaImage::from_pixel(32, 32, image::Rgba([0, 0, 0, 0]));

        render_status_indicator(&mut image, TrayStatusIndicator::Failed);

        let changed_pixels = image
            .pixels()
            .filter(|pixel| **pixel == indicator_color(TrayStatusIndicator::Failed))
            .count();
        assert!(changed_pixels > 0);
    }

    #[test]
    fn render_status_indicator_places_dot_in_top_right_corner() {
        let mut image = image::RgbaImage::from_pixel(32, 32, image::Rgba([0, 0, 0, 0]));

        render_status_indicator(&mut image, TrayStatusIndicator::WaitingApproval);

        let target_color = indicator_color(TrayStatusIndicator::WaitingApproval);
        let mut top_right_pixels = 0;
        let mut bottom_right_pixels = 0;

        for x in 16..32 {
            for y in 0..16 {
                if *image.get_pixel(x, y) == target_color {
                    top_right_pixels += 1;
                }
            }
        }

        for x in 16..32 {
            for y in 16..32 {
                if *image.get_pixel(x, y) == target_color {
                    bottom_right_pixels += 1;
                }
            }
        }

        assert!(top_right_pixels > 0);
        assert!(top_right_pixels > bottom_right_pixels);
    }
}
