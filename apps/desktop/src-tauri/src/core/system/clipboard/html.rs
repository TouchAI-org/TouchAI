// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 剪贴板 HTML 片段解析。

use clipboard_rs::{Clipboard, ClipboardContext};
use html5gum::{HtmlString, Spanned, StartTag, Token, Tokenizer};
use reqwest::Url;
use std::{
    collections::{BTreeMap, HashMap},
    path::Path,
};

use super::{
    image::{normalize_clipboard_file_path, path_has_known_image_extension},
    payload::{ClipboardHtmlFragment, ClipboardPayloadFragment},
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

/// 从 HTML 中提取有序的文本和图片片段。
pub(super) fn extract_html_clipboard_fragments(
    html: &str,
    source_url: Option<&str>,
) -> Vec<ClipboardHtmlFragment> {
    HtmlClipboardFragmentExtractor::new(source_url).extract(html)
}

struct HtmlClipboardFragmentExtractor<'a> {
    source_url: Option<&'a str>,
    text_buffer: String,
    fragments: Vec<ClipboardHtmlFragment>,
    anchor_stack: Vec<Option<String>>,
    tag_stack: Vec<(String, bool)>,
    skip_hidden_depth: usize,
}

impl<'a> HtmlClipboardFragmentExtractor<'a> {
    /// 创建 HTML 剪贴板片段提取器。
    fn new(source_url: Option<&'a str>) -> Self {
        Self {
            source_url,
            text_buffer: String::new(),
            fragments: Vec::new(),
            anchor_stack: Vec::new(),
            tag_stack: Vec::new(),
            skip_hidden_depth: 0,
        }
    }

    /// 扫描 HTML token 并输出有序片段。
    fn extract(mut self, html: &str) -> Vec<ClipboardHtmlFragment> {
        //1. tokenizer 只负责容错切分 HTML，避免本地继续维护脆弱的标签/属性扫描器。
        //2. 本地状态只保留剪贴板业务需要的上下文：隐藏层级、外层链接和片段顺序。
        for token in Tokenizer::new(html) {
            match token {
                Ok(token) => self.handle_token(token),
                Err(error) => match error {},
            }
        }

        self.flush_text();
        self.fragments
    }

    /// 根据 token 类型更新片段状态。
    fn handle_token(&mut self, token: Token) {
        match token {
            Token::StartTag(tag) => self.handle_start_tag(&tag),
            Token::EndTag(tag) => self.handle_end_tag(&tag_name_to_string(&tag.name)),
            Token::String(text) => self.push_html_text(&text.value),
            Token::Comment(_) | Token::Doctype(_) | Token::Error(_) => {}
        }
    }

    /// 处理开始标签并更新上下文。
    fn handle_start_tag(&mut self, tag: &StartTag<()>) {
        let tag_name = tag_name_to_string(&tag.name);
        let is_hidden = is_hidden_html_element(&tag.attributes);

        if is_hidden {
            self.skip_hidden_depth += 1;
        }

        match tag_name.as_str() {
            "a" => {
                let href = html_attr_string(&tag.attributes, b"href")
                    .and_then(|href| resolve_html_image_reference(&href, self.source_url));
                self.anchor_stack.push(href);
            }
            "br" => self.push_line_break(),
            "p" | "div" | "li" | "tr" => self.push_block_break(),
            "img" => {
                if self.skip_hidden_depth == 0 {
                    if let Some(source) = self.choose_image_source(&tag.attributes) {
                        // 图片前先落盘文字片段，后续 draft offset 才能还原 text/image/text。
                        self.flush_text();
                        push_unique_html_fragment(
                            &mut self.fragments,
                            ClipboardHtmlFragment::ImageSource(source),
                        );
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

    /// 处理结束标签并关闭相关上下文。
    fn handle_end_tag(&mut self, tag_name: &str) {
        match tag_name {
            "a" => {
                self.anchor_stack.pop();
            }
            "p" | "div" | "li" | "tr" => self.push_block_break(),
            _ => {}
        }

        self.close_tag_stack(tag_name);
    }

    /// 关闭 void 或自闭合标签带来的临时上下文。
    fn close_self_contained_tag(&mut self, tag_name: &str, is_hidden: bool) {
        if tag_name == "a" {
            self.anchor_stack.pop();
        }
        if is_hidden {
            self.skip_hidden_depth = self.skip_hidden_depth.saturating_sub(1);
        }
    }

    /// 从标签栈中关闭指定标签。
    fn close_tag_stack(&mut self, tag_name: &str) {
        while let Some((open_tag_name, is_hidden)) = self.tag_stack.pop() {
            if is_hidden {
                self.skip_hidden_depth = self.skip_hidden_depth.saturating_sub(1);
            }
            if open_tag_name == tag_name {
                break;
            }
        }
    }

    /// 选择当前图片标签最合适的图片来源。
    fn choose_image_source(&self, img_attrs: &HtmlAttributes) -> Option<String> {
        //1. 富文本复制常把缩略图包在原图链接里，优先使用外层 href。
        if let Some(anchor_href) = self.anchor_stack.iter().rev().flatten().next() {
            if looks_like_image_reference(anchor_href) {
                return Some(anchor_href.clone());
            }
        }

        //2. 找不到外层原图链接时，再回退到 img 自身的 srcset/src。
        choose_html_image_source(img_attrs, self.source_url)
    }

    /// 将 HTML string token 追加到文本缓冲区。
    fn push_html_text(&mut self, text: &HtmlString) {
        if self.skip_hidden_depth > 0 {
            return;
        }

        self.push_text(&html_string_to_string(text));
    }

    /// 将文本追加到当前文本缓冲区。
    fn push_text(&mut self, text: &str) {
        for ch in text.chars() {
            if ch.is_whitespace() || ch == '\u{00a0}' {
                if !self.text_buffer.ends_with([' ', '\n']) {
                    self.text_buffer.push(' ');
                }
                continue;
            }

            self.text_buffer.push(ch);
        }
    }

    /// 向文本缓冲区追加换行。
    fn push_line_break(&mut self) {
        if self.skip_hidden_depth > 0 {
            return;
        }
        if !self.text_buffer.ends_with('\n') {
            self.text_buffer.push('\n');
        }
    }

    /// 在块级元素边界追加换行。
    fn push_block_break(&mut self) {
        if self.skip_hidden_depth > 0 || self.text_buffer.is_empty() {
            return;
        }
        if !self.text_buffer.ends_with('\n') {
            self.text_buffer.push('\n');
        }
    }

    /// 将文本缓冲区落盘为片段。
    fn flush_text(&mut self) {
        let text = self.text_buffer.trim().to_string();
        self.text_buffer.clear();
        if text.is_empty() {
            return;
        }

        push_unique_html_fragment(&mut self.fragments, ClipboardHtmlFragment::Text(text));
    }
}

/// 向 HTML 片段列表追加去重后的片段。
fn push_unique_html_fragment(
    fragments: &mut Vec<ClipboardHtmlFragment>,
    fragment: ClipboardHtmlFragment,
) {
    if fragments.last() == Some(&fragment) {
        return;
    }

    match fragment {
        ClipboardHtmlFragment::Text(text) => {
            if text.is_empty() {
                return;
            }

            if let Some(ClipboardHtmlFragment::Text(previous)) = fragments.last_mut() {
                previous.push_str(&text);
                return;
            }

            fragments.push(ClipboardHtmlFragment::Text(text));
        }
        ClipboardHtmlFragment::ImageSource(source) => {
            if fragments.iter().any(|existing| {
                matches!(existing, ClipboardHtmlFragment::ImageSource(existing_source) if existing_source == &source)
            }) {
                return;
            }
            fragments.push(ClipboardHtmlFragment::ImageSource(source));
        }
    }
}

/// 将 tag name 转为小写字符串。
fn tag_name_to_string(name: &HtmlString) -> String {
    html_string_to_string(name).to_ascii_lowercase()
}

/// 判断标签是否是无闭合内容的 void 标签。
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

/// 将 HTML 片段映射为前端 payload fragments。
pub(super) fn build_payload_fragments_from_html(
    html_fragments: &[ClipboardHtmlFragment],
    image_path_by_source: &HashMap<&str, String>,
) -> Vec<ClipboardPayloadFragment> {
    html_fragments
        .iter()
        .filter_map(|fragment| match fragment {
            ClipboardHtmlFragment::Text(text) => {
                Some(ClipboardPayloadFragment::Text { text: text.clone() })
            }
            ClipboardHtmlFragment::ImageSource(source) => image_path_by_source
                .get(source.as_str())
                .map(|path| ClipboardPayloadFragment::Image { path: path.clone() }),
        })
        .collect()
}

/// 从 payload fragments 中拼出纯文本内容。
pub(super) fn build_payload_text(fragments: &[ClipboardPayloadFragment]) -> Option<String> {
    let text = fragments
        .iter()
        .filter_map(|fragment| match fragment {
            ClipboardPayloadFragment::Text { text } => Some(text.as_str()),
            ClipboardPayloadFragment::Image { .. } | ClipboardPayloadFragment::File { .. } => None,
        })
        .collect::<String>();

    if text.trim().is_empty() {
        None
    } else {
        Some(text)
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

/// 从 HTML 中提取粗略纯文本。
fn extract_html_text(html: &str) -> Option<String> {
    let text = extract_html_clipboard_fragments(html, None)
        .into_iter()
        .filter_map(|fragment| match fragment {
            ClipboardHtmlFragment::Text(text) => Some(text),
            ClipboardHtmlFragment::ImageSource(_) => None,
        })
        .collect::<String>();

    let normalized = normalize_clipboard_text_for_compare(&text);
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}
