// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 剪贴板 HTML 元信息解析。

use clipboard_rs::{Clipboard, ClipboardContext};
use html5gum::{HtmlString, Spanned, StartTag, Token, Tokenizer};
use reqwest::Url;
use std::{
    collections::{BTreeMap, HashMap},
    path::Path,
};

use super::{
    image::{normalize_clipboard_file_path, path_has_known_image_extension},
    payload::{ClipboardHtmlImage, ClipboardPayloadFragment},
};

const CLIPBOARD_HTML_FORMAT: &str = "HTML Format";

type HtmlAttributes = BTreeMap<HtmlString, Spanned<HtmlString, ()>>;

/// 读取 Windows CF_HTML 头部中的 SourceURL。
pub(super) fn read_clipboard_html_source_url(context: &ClipboardContext) -> Option<String> {
    let buffer = context.get_buffer(CLIPBOARD_HTML_FORMAT).ok()?;
    let raw = String::from_utf8_lossy(&buffer);
    extract_cf_html_source_url(&raw)
}

/// 从 CF_HTML 原始文本中提取 SourceURL。
fn extract_cf_html_source_url(raw: &str) -> Option<String> {
    for line in raw.lines() {
        if line.trim_start().starts_with('<') {
            break;
        }

        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.eq_ignore_ascii_case("SourceURL") {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }

    None
}

/// 从 HTML 中提取图片来源。正文富文本转换由前端复用 DOMPurify/Turndown 完成。
pub(super) fn extract_html_clipboard_images(
    html: &str,
    source_url: Option<&str>,
) -> Vec<ClipboardHtmlImage> {
    HtmlImageSourceExtractor::new(source_url).extract(html)
}

struct HtmlImageSourceExtractor<'a> {
    source_url: Option<&'a str>,
    image_sources: Vec<ClipboardHtmlImage>,
    anchor_stack: Vec<Option<String>>,
    tag_stack: Vec<(String, bool)>,
    skip_hidden_depth: usize,
}

impl<'a> HtmlImageSourceExtractor<'a> {
    fn new(source_url: Option<&'a str>) -> Self {
        Self {
            source_url,
            image_sources: Vec::new(),
            anchor_stack: Vec::new(),
            tag_stack: Vec::new(),
            skip_hidden_depth: 0,
        }
    }

    fn extract(mut self, html: &str) -> Vec<ClipboardHtmlImage> {
        for token in Tokenizer::new(html) {
            match token {
                Ok(Token::StartTag(tag)) => self.handle_start_tag(&tag),
                Ok(Token::EndTag(tag)) => self.handle_end_tag(&tag_name_to_string(&tag.name)),
                Ok(Token::String(_) | Token::Comment(_) | Token::Doctype(_) | Token::Error(_)) => {}
                Err(error) => match error {},
            }
        }

        self.image_sources
    }

    fn handle_start_tag(&mut self, tag: &StartTag<()>) {
        let tag_name = tag_name_to_string(&tag.name);
        let is_hidden =
            is_hidden_html_element(&tag.attributes) || is_non_visible_html_element(&tag_name);

        if is_hidden {
            self.skip_hidden_depth += 1;
        }

        match tag_name.as_str() {
            "a" => {
                let href = html_attr_string(&tag.attributes, b"href")
                    .and_then(|href| resolve_html_reference(&href, self.source_url));
                self.anchor_stack.push(href);
            }
            "img" => {
                if self.skip_hidden_depth == 0 {
                    if let Some(source) = self.choose_image_source(&tag.attributes) {
                        self.image_sources
                            .push(ClipboardHtmlImage { source, path: None });
                    }
                }
            }
            _ => {}
        }

        if is_void_html_tag(&tag_name) || tag.self_closing {
            self.close_self_contained_tag(&tag_name, is_hidden);
        } else {
            self.tag_stack.push((tag_name, is_hidden));
        }
    }

    fn handle_end_tag(&mut self, tag_name: &str) {
        while let Some((open_tag_name, is_hidden)) = self.tag_stack.pop() {
            if is_hidden {
                self.skip_hidden_depth = self.skip_hidden_depth.saturating_sub(1);
            }
            if open_tag_name == "a" {
                self.anchor_stack.pop();
            }
            if open_tag_name == tag_name {
                break;
            }
        }
    }

    fn close_self_contained_tag(&mut self, tag_name: &str, is_hidden: bool) {
        if tag_name == "a" {
            self.anchor_stack.pop();
        }
        if is_hidden {
            self.skip_hidden_depth = self.skip_hidden_depth.saturating_sub(1);
        }
    }

    fn choose_image_source(&self, img_attrs: &HtmlAttributes) -> Option<String> {
        if let Some(anchor_href) = self.anchor_stack.iter().rev().flatten().next() {
            if looks_like_image_reference(anchor_href) {
                return Some(anchor_href.clone());
            }
        }

        choose_html_image_source(img_attrs, self.source_url)
    }
}

/// 从图片 source 到已缓存本地路径的映射中生成前端附件 fragment。
pub(super) fn build_payload_fragments_from_html_images(
    html_images: &[ClipboardHtmlImage],
    image_path_by_source: &HashMap<String, String>,
) -> Vec<ClipboardPayloadFragment> {
    html_images
        .iter()
        .filter_map(|image| {
            image_path_by_source
                .get(&image.source)
                .map(|path| ClipboardPayloadFragment::Image { path: path.clone() })
        })
        .collect()
}

/// 判断剪贴板 native 图片通道是否应保留。
pub(super) fn should_keep_clipboard_image(
    text: Option<&str>,
    html: Option<&str>,
    has_files: bool,
) -> bool {
    if has_files {
        return true;
    }

    let Some(html) = html.map(str::trim).filter(|value| !value.is_empty()) else {
        return true;
    };

    let html_lower = html.to_ascii_lowercase();
    if html_lower.contains("<img") {
        return true;
    }

    // 有些系统会把纯文字的 HTML 副本也暴露为 Image；文本一致时丢弃这类伪图片。
    let normalized_text = text.map(normalize_clipboard_text_for_compare);
    let normalized_html_text = extract_html_text(html);

    if normalized_text.is_some()
        && normalized_html_text.is_some()
        && normalized_text == normalized_html_text
    {
        return false;
    }

    true
}

/// 归一化剪贴板文本用于相等比较。
fn normalize_clipboard_text_for_compare(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 从 HTML 中提取粗略纯文本。这里仅用于判断 native image 是否为伪图片。
fn extract_html_text(html: &str) -> Option<String> {
    let mut text = String::new();
    let mut skip_hidden_depth = 0usize;
    let mut tag_stack: Vec<(String, bool)> = Vec::new();

    for token in Tokenizer::new(html) {
        match token {
            Ok(Token::StartTag(tag)) => {
                let tag_name = tag_name_to_string(&tag.name);
                let is_hidden = is_hidden_html_element(&tag.attributes)
                    || is_non_visible_html_element(&tag_name);
                if is_hidden {
                    skip_hidden_depth += 1;
                }
                if is_void_html_tag(&tag_name) || tag.self_closing {
                    if is_hidden {
                        skip_hidden_depth = skip_hidden_depth.saturating_sub(1);
                    }
                } else {
                    tag_stack.push((tag_name, is_hidden));
                }
            }
            Ok(Token::EndTag(tag)) => {
                let tag_name = tag_name_to_string(&tag.name);
                while let Some((open_tag_name, is_hidden)) = tag_stack.pop() {
                    if is_hidden {
                        skip_hidden_depth = skip_hidden_depth.saturating_sub(1);
                    }
                    if open_tag_name == tag_name {
                        break;
                    }
                }
            }
            Ok(Token::String(value)) => {
                if skip_hidden_depth == 0 {
                    text.push_str(&html_string_to_string(&value.value));
                    text.push(' ');
                }
            }
            Ok(Token::Comment(_) | Token::Doctype(_) | Token::Error(_)) => {}
            Err(error) => match error {},
        }
    }

    let normalized = normalize_clipboard_text_for_compare(&text);
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

/// 从 img 标签属性中选择图片来源。
fn choose_html_image_source(
    img_attrs: &HtmlAttributes,
    source_url: Option<&str>,
) -> Option<String> {
    if let Some(srcset) = html_attr_string(img_attrs, b"srcset") {
        if let Some(source) = choose_srcset_image_source(&srcset)
            .and_then(|source| resolve_html_image_reference(&source, source_url))
        {
            return Some(source);
        }
    }

    html_attr_string(img_attrs, b"src")
        .and_then(|source| resolve_html_image_reference(&source, source_url))
}

/// 从 srcset 中选择分数最高的候选图片。
fn choose_srcset_image_source(srcset: &str) -> Option<String> {
    let mut best_source = None;
    let mut best_score = f64::MIN;

    for candidate in srcset.split(',') {
        let mut parts = candidate.split_whitespace();
        let Some(source) = parts.next() else {
            continue;
        };
        let score = parts
            .next()
            .and_then(parse_srcset_descriptor_score)
            .unwrap_or(1.0);

        if score > best_score {
            best_score = score;
            best_source = Some(source.to_string());
        }
    }

    best_source
}

/// 将 srcset 描述符转换为排序分数。
fn parse_srcset_descriptor_score(descriptor: &str) -> Option<f64> {
    if let Some(width) = descriptor.strip_suffix('w') {
        return width.parse::<f64>().ok();
    }

    descriptor
        .strip_suffix('x')
        .and_then(|density| density.parse::<f64>().ok())
        .map(|density| density * 10_000.0)
}

/// 将 HTML 图片引用解析为绝对可读取地址。
fn resolve_html_image_reference(source: &str, source_url: Option<&str>) -> Option<String> {
    let source = source.trim().to_string();
    if source.is_empty() {
        return None;
    }

    let lower_source = source.to_ascii_lowercase();
    if lower_source.starts_with("data:image/") {
        return Some(source);
    }
    if lower_source.starts_with("blob:") || lower_source.starts_with("cid:") {
        return None;
    }
    if Path::new(&source).is_absolute() {
        return Some(source);
    }

    if let Ok(url) = Url::parse(&source) {
        if matches!(url.scheme(), "http" | "https" | "file") {
            return Some(url.to_string());
        }

        return None;
    }

    source_url
        .and_then(|value| Url::parse(value).ok())
        .and_then(|base_url| base_url.join(&source).ok())
        .map(|url| url.to_string())
}

fn resolve_html_reference(source: &str, source_url: Option<&str>) -> Option<String> {
    let source = source.trim();
    if source.is_empty() {
        return None;
    }

    let lower_source = source.to_ascii_lowercase();
    if lower_source.starts_with("javascript:")
        || lower_source.starts_with("vbscript:")
        || lower_source.starts_with("data:text/html")
    {
        return None;
    }

    if lower_source.starts_with('#') {
        return Some(source.to_string());
    }
    if Path::new(source).is_absolute() {
        return Some(source.to_string());
    }
    if let Ok(url) = Url::parse(source) {
        if matches!(
            url.scheme(),
            "http" | "https" | "file" | "mailto" | "tel" | "ftp"
        ) {
            return Some(url.to_string());
        }

        return None;
    }

    source_url
        .and_then(|value| Url::parse(value).ok())
        .and_then(|base_url| base_url.join(source).ok())
        .map(|url| url.to_string())
        .or_else(|| Some(source.to_string()))
}

/// 判断字符串是否像图片引用。
fn looks_like_image_reference(source: &str) -> bool {
    let lower_source = source.to_ascii_lowercase();
    if lower_source.starts_with("data:image/") {
        return true;
    }

    if lower_source.starts_with("file://") {
        return path_has_known_image_extension(&normalize_clipboard_file_path(source));
    }

    if let Ok(url) = Url::parse(source) {
        return path_has_known_image_extension(url.path());
    }

    path_has_known_image_extension(source)
}

/// 将 tokenizer tag name 转为统一小写字符串。
fn tag_name_to_string(value: &HtmlString) -> String {
    html_string_to_string(value).to_ascii_lowercase()
}

fn is_void_html_tag(tag_name: &str) -> bool {
    matches!(
        tag_name,
        "area"
            | "base"
            | "br"
            | "col"
            | "embed"
            | "hr"
            | "img"
            | "input"
            | "link"
            | "meta"
            | "source"
            | "track"
            | "wbr"
    )
}

/// 判断标签内容是否不属于用户可见正文。
fn is_non_visible_html_element(tag_name: &str) -> bool {
    matches!(
        tag_name,
        "head" | "style" | "script" | "noscript" | "template" | "meta" | "link" | "title"
    )
}

/// 判断 HTML 元素是否应视为隐藏内容。
fn is_hidden_html_element(attrs: &HtmlAttributes) -> bool {
    if has_html_attr(attrs, b"hidden") {
        return true;
    }

    html_attr_string(attrs, b"style")
        .map(|style| normalize_hidden_style(&style))
        .is_some_and(|style| {
            style.contains("display:none")
                || style.contains("visibility:hidden")
                || style.contains("opacity:0")
        })
}

/// 归一化内联样式以便判断隐藏状态。
fn normalize_hidden_style(style: &str) -> String {
    style
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>()
        .to_ascii_lowercase()
}

/// 判断属性列表中是否存在指定属性。
fn has_html_attr(attrs: &HtmlAttributes, name: &[u8]) -> bool {
    attrs.contains_key(name)
}

/// 从属性列表读取指定属性值。
fn html_attr_string(attrs: &HtmlAttributes, name: &[u8]) -> Option<String> {
    attrs
        .get(name)
        .map(|value| html_string_to_string(&value.value))
}

/// 将 tokenizer 字节串转为 Rust 字符串。
fn html_string_to_string(value: &HtmlString) -> String {
    String::from_utf8_lossy(value.as_ref()).into_owned()
}

#[cfg(test)]
mod tests {
    use super::{extract_html_clipboard_images, should_keep_clipboard_image, ClipboardHtmlImage};

    #[test]
    fn html_image_extraction_skips_hidden_images_and_uses_anchor_originals() {
        let html = r#"
            <p>Before</p>
            <img style="display: none" src="hidden.png">
            <a href="https://example.com/full.png">
                <img src="thumb.png" alt="Preview">
            </a>
            <img srcset="small.jpg 320w, large.jpg 960w" src="fallback.jpg">
        "#;

        let images =
            extract_html_clipboard_images(html, Some("https://example.com/post/index.html"));

        assert_eq!(
            images,
            vec![
                ClipboardHtmlImage {
                    source: "https://example.com/full.png".to_string(),
                    path: None,
                },
                ClipboardHtmlImage {
                    source: "https://example.com/post/large.jpg".to_string(),
                    path: None,
                },
            ]
        );
    }

    #[test]
    fn html_image_extraction_preserves_repeated_visible_image_occurrences() {
        let html = r#"
            <img src="https://example.com/reused.png">
            <p>Between</p>
            <img src="https://example.com/reused.png">
        "#;

        let images = extract_html_clipboard_images(html, None);

        assert_eq!(
            images,
            vec![
                ClipboardHtmlImage {
                    source: "https://example.com/reused.png".to_string(),
                    path: None,
                },
                ClipboardHtmlImage {
                    source: "https://example.com/reused.png".to_string(),
                    path: None,
                },
            ]
        );
    }

    #[test]
    fn should_drop_native_image_when_html_text_matches_plain_text() {
        assert!(!should_keep_clipboard_image(
            Some("Visible Word text Second line"),
            Some(
                r#"<html><head><style>p{color:red}</style></head><body><p>Visible Word text</p><p>Second line</p></body></html>"#
            ),
            false
        ));
    }

    #[test]
    fn should_keep_native_image_when_html_contains_image() {
        assert!(should_keep_clipboard_image(
            Some("Visible"),
            Some("<p>Visible</p><img src=\"clip.png\">"),
            false
        ));
    }
}
