// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! macOS Spotlight 快速搜索提供者。
//!
//! 第一版使用系统 `mdfind`，避免引入额外 Objective-C 绑定；后续如果需要更强的
//! 图标、权限诊断或实时索引状态，再升级到 Metadata framework / FSEvents。

use std::{
    collections::HashSet,
    path::Path,
    process::{Command, Stdio},
};

use super::types::{QuickSearchFileItem, QuickSearchResult, QuickSearchStatus, QuickShortcutItem};

const PROVIDER_NAME: &str = "spotlight";

/// 执行 QuickSearch 主查询。
pub fn search_shortcuts(
    query: &str,
    page_size: usize,
    offset: u32,
) -> Result<QuickSearchResult, String> {
    let trimmed_query = query.trim();
    if trimmed_query.is_empty() {
        return Ok(empty_result());
    }

    let fetch_limit = page_size
        .saturating_add(offset as usize)
        .saturating_add(1)
        .max(page_size);
    let paths = run_mdfind(trimmed_query, fetch_limit)?;
    let total_results = paths.len() as u32;
    let files = paths
        .iter()
        .skip(offset as usize)
        .take(page_size)
        .filter_map(|path| spotlight_item_from_path(&path))
        .collect::<Vec<_>>();

    let total_files = files.len();
    let next_offset = offset + total_files as u32;
    Ok(QuickSearchResult {
        shortcuts: Vec::new(),
        files,
        total_files,
        total_results,
        next_offset,
    })
}

/// 执行内置 file_search 查询。
pub fn search_files(
    query: &str,
    limit: usize,
    _include_shortcuts: bool,
) -> Result<Vec<QuickSearchFileItem>, String> {
    let trimmed_query = query.trim();
    if trimmed_query.is_empty() {
        return Ok(Vec::new());
    }

    Ok(run_mdfind(trimmed_query, limit)?
        .into_iter()
        .filter_map(|path| {
            let item = spotlight_item_from_path(&path)?;
            Some(QuickSearchFileItem {
                name: item.name,
                path: item.path,
            })
        })
        .collect())
}

/// Spotlight 无需显式预热，保留命令契约。
pub fn prepare_index(_force: Option<bool>) -> Result<(), String> {
    Ok(())
}

/// 返回 macOS provider 状态。
pub fn get_status() -> QuickSearchStatus {
    QuickSearchStatus {
        provider: PROVIDER_NAME.to_string(),
        db_loaded: true,
        index_warmed: true,
        last_refresh_ms: None,
        last_error: None,
    }
}

fn empty_result() -> QuickSearchResult {
    QuickSearchResult {
        shortcuts: Vec::new(),
        files: Vec::new(),
        total_files: 0,
        total_results: 0,
        next_offset: 0,
    }
}

fn run_mdfind(query: &str, limit: usize) -> Result<Vec<String>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }

    let output = Command::new("mdfind")
        .arg("-name")
        .arg(query)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("执行 Spotlight 搜索失败: {}", error))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Spotlight 搜索失败".to_string()
        } else {
            format!("Spotlight 搜索失败: {}", stderr)
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_mdfind_output(&stdout, limit))
}

fn parse_mdfind_output(output: &str, limit: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut paths = Vec::new();

    for line in output.lines() {
        let path = line.trim();
        if path.is_empty() || !seen.insert(path.to_string()) {
            continue;
        }

        paths.push(path.to_string());
        if paths.len() >= limit {
            break;
        }
    }

    paths
}

fn spotlight_item_from_path(path: &str) -> Option<QuickShortcutItem> {
    let path_obj = Path::new(path);
    let name = path_obj.file_name()?.to_string_lossy().trim().to_string();
    if name.is_empty() {
        return None;
    }

    Some(QuickShortcutItem {
        name,
        path: path.to_string(),
        source: "file".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::{parse_mdfind_output, spotlight_item_from_path};

    #[test]
    fn parse_mdfind_output_deduplicates_and_limits_paths() {
        let output = "/Users/qian/Desktop/App.app\n\n/Users/qian/Desktop/App.app\n/Users/qian/Documents/Note.md\n";

        let paths = parse_mdfind_output(output, 2);

        assert_eq!(
            paths,
            vec![
                "/Users/qian/Desktop/App.app".to_string(),
                "/Users/qian/Documents/Note.md".to_string()
            ]
        );
    }

    #[test]
    fn spotlight_item_uses_file_name_as_display_name() {
        let item = spotlight_item_from_path("/Users/qian/Documents/Note.md").unwrap();

        assert_eq!(item.name, "Note.md");
        assert_eq!(item.path, "/Users/qian/Documents/Note.md");
        assert_eq!(item.source, "file");
    }
}
