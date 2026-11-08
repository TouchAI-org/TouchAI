// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

//! Product font preparation commands.

/// Returns a font file the renderer can load after the compressed asset was
/// rejected by the WebView engine.
///
/// WebKitGTK's WOFF2 decoder enforces a 30 MB output limit. The full Source Han
/// Serif face expands to 60 MB, so the native side decodes it once and caches a
/// plain TTF for WebKit. Other platforms keep using the original asset.
#[tauri::command]
pub async fn prepare_product_font_file() -> Result<String, String> {
    crate::core::system::assets::prepare_product_font_file().await
}
