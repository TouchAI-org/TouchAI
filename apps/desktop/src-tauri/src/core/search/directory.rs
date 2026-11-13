// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 目录路径查询。
//!
//! `@` 引用输入一个目录时，Everything 的模糊结果无法精确表达该目录的直接内容。
//! 这里用文件系统直接枚举，并复用分页结果结构，避免再引入一套前端分页。
//! 该实现不依赖平台，Windows / macOS / Linux 共用。

use std::{
    fs,
    path::{Path, PathBuf},
};

use crate::core::search::types::{QuickSearchResult, QuickShortcutItem};

const MAX_DIRECTORY_RESULTS: usize = 200;

struct DirectoryEntry {
    name: String,
    path: String,
    is_dir: bool,
}

/// 解析目录查询并返回当前页的直接文件与目录。
///
/// 返回 `None` 表示输入不是路径，调用方应继续走模糊搜索。
/// 输入看起来是路径但没有可枚举目录时返回空的确定结果，避免又回落到模糊匹配。
/// 直接读文件系统也覆盖 OneDrive 等 Everything 可能未索引的目录。
pub(crate) fn list_directory_query(
    query: &str,
    limit: usize,
    offset: u32,
) -> Option<QuickSearchResult> {
    list_directory_query_in(query, limit, offset, home_directory().as_deref())
}

fn list_directory_query_in(
    query: &str,
    limit: usize,
    offset: u32,
    home: Option<&Path>,
) -> Option<QuickSearchResult> {
    let (directory, prefix) = resolve_directory_query_in(query, home)?;
    let prefix_lower = prefix.to_lowercase();
    let mut entries: Vec<DirectoryEntry> = read_entries(&directory)
        .into_iter()
        .filter(|entry| {
            prefix_lower.is_empty() || entry.name.to_lowercase().starts_with(&prefix_lower)
        })
        .collect();

    // 目录优先，方便用户继续浏览；同组内按名称稳定排序。
    entries.sort_by(|left, right| {
        right.is_dir.cmp(&left.is_dir).then_with(|| {
            let left_name = left.name.to_lowercase();
            let right_name = right.name.to_lowercase();
            left_name
                .cmp(&right_name)
                .then_with(|| left.name.cmp(&right.name))
        })
    });

    let total = entries.len();
    let bounded_limit = limit.clamp(1, MAX_DIRECTORY_RESULTS);
    let start = (offset as usize).min(total);
    let page = entries
        .into_iter()
        .skip(start)
        .take(bounded_limit)
        .map(|entry| QuickShortcutItem {
            name: entry.name,
            path: entry.path,
            source: if entry.is_dir { "folder" } else { "file" }.to_string(),
        })
        .collect();
    let next_offset = start.saturating_add(bounded_limit).min(u32::MAX as usize) as u32;

    Some(QuickSearchResult {
        shortcuts: Vec::new(),
        files: page,
        total_files: total,
        total_results: total.min(u32::MAX as usize) as u32,
        next_offset,
    })
}

/// 把用户输入解析成「要枚举的目录 + 名称前缀」。
///
/// - 已存在的目录（带或不带结尾分隔符）：枚举该目录。
/// - 目录下的名称前缀：枚举父目录并保留前缀。
/// - 精确文件路径：枚举父目录并用完整文件名过滤，因此精确文件也能被引用。
/// - 非路径输入返回 `None`，由调用方继续处理。
fn resolve_directory_query_in(query: &str, home: Option<&Path>) -> Option<(PathBuf, String)> {
    let trimmed = strip_wrapping_quotes(query.trim());
    if trimmed.is_empty() {
        return None;
    }

    let expanded = expand_home(trimmed, home)?;
    if expanded.is_dir() {
        return Some((expanded, String::new()));
    }

    let parent = expanded.parent()?;
    if !parent.is_dir() {
        // 路径形态但没有可用父目录：给出空结果，不再做模糊搜索。
        return Some((expanded, String::new()));
    }

    let prefix = expanded.file_name()?.to_string_lossy().to_string();
    Some((parent.to_path_buf(), prefix))
}

fn expand_home(query: &str, home: Option<&Path>) -> Option<PathBuf> {
    let path = Path::new(query);
    if query == "~" {
        return home.map(Path::to_path_buf);
    }
    if let Some(rest) = query.strip_prefix("~/") {
        return Some(home?.join(rest));
    }
    #[cfg(target_os = "windows")]
    if let Some(rest) = query.strip_prefix("~\\") {
        return Some(home?.join(rest));
    }
    if is_path_like(query) {
        return Some(path.to_path_buf());
    }
    None
}

fn is_path_like(query: &str) -> bool {
    if Path::new(query).is_absolute() || query == "~" || query.starts_with("~/") {
        return true;
    }

    #[cfg(target_os = "windows")]
    {
        let bytes = query.as_bytes();
        return query.starts_with("~\\")
            || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':');
    }

    #[cfg(not(target_os = "windows"))]
    false
}

fn home_directory() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

fn strip_wrapping_quotes(value: &str) -> &str {
    let bytes = value.as_bytes();
    if bytes.len() >= 2
        && ((bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\''))
    {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

fn read_entries(directory: &Path) -> Vec<DirectoryEntry> {
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };

    entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let metadata = entry.metadata().ok()?;
            let is_dir = metadata.is_dir();
            if !is_dir && !metadata.is_file() {
                return None;
            }
            let name = entry.file_name().to_str()?.to_string();
            let path = normalize_path_for_output(&entry.path());
            Some(DirectoryEntry { name, path, is_dir })
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn normalize_path_for_output(path: &Path) -> String {
    // Everything 在 Windows 返回 `\` 分隔的绝对路径；目录枚举保持同一约定。
    path.to_string_lossy().replace('/', "\\")
}

#[cfg(not(target_os = "windows"))]
fn normalize_path_for_output(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

#[cfg(test)]
mod tests {
    use std::{fs, path::MAIN_SEPARATOR};

    use super::{list_directory_query, list_directory_query_in, resolve_directory_query_in};

    fn create_file(root: &std::path::Path, name: &str) -> std::path::PathBuf {
        let path = root.join(name);
        fs::write(&path, name).expect("fixture file");
        path
    }

    fn child_path(root: &std::path::Path, name: &str) -> String {
        format!("{}{}{}", root.display(), MAIN_SEPARATOR, name)
    }

    #[test]
    fn user_typing_a_directory_path_gets_that_directory_files_and_folders() {
        let root = tempfile::tempdir().expect("temp directory");
        let nested = root.path().join("nested");
        fs::create_dir(&nested).expect("nested directory");
        create_file(root.path(), "alpha.txt");
        create_file(root.path(), "beta.md");
        create_file(&nested, "inside.txt");

        let result =
            list_directory_query(&child_path(root.path(), ""), 60, 0).expect("directory query");

        let items: Vec<_> = result
            .files
            .iter()
            .map(|item| (item.name.as_str(), item.source.as_str()))
            .collect();
        assert_eq!(
            items,
            vec![
                ("nested", "folder"),
                ("alpha.txt", "file"),
                ("beta.md", "file")
            ]
        );
        assert_eq!(result.total_files, 3);
    }

    #[test]
    fn user_can_browse_a_home_relative_directory() {
        let home = tempfile::tempdir().expect("home directory");
        let docs = home.path().join("Documents");
        fs::create_dir(&docs).expect("documents directory");
        create_file(&docs, "plan.md");

        let result = list_directory_query_in("~/Documents", 60, 0, Some(home.path()))
            .expect("home-relative directory");

        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].name, "plan.md");
        assert_eq!(result.files[0].source, "file");
    }

    #[test]
    fn user_can_browse_a_home_relative_directory_with_a_trailing_separator() {
        let home = tempfile::tempdir().expect("home directory");
        let docs = home.path().join("Documents");
        fs::create_dir(&docs).expect("documents directory");
        create_file(&docs, "plan.md");

        let query = format!("~{}{}", MAIN_SEPARATOR, "Documents");
        let result = list_directory_query_in(&query, 60, 0, Some(home.path()))
            .expect("home-relative directory");

        assert_eq!(result.files[0].name, "plan.md");
    }

    #[test]
    fn user_typing_a_file_prefix_gets_matching_direct_files() {
        let root = tempfile::tempdir().expect("temp directory");
        create_file(root.path(), "report.pdf");
        create_file(root.path(), "report.txt");
        create_file(root.path(), "other.txt");

        let result = list_directory_query(&format!("{}report", child_path(root.path(), "")), 60, 0)
            .expect("directory query");

        assert_eq!(
            result
                .files
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            vec!["report.pdf", "report.txt"]
        );
    }

    #[test]
    fn user_typing_an_existing_file_path_gets_the_exact_file() {
        let root = tempfile::tempdir().expect("temp directory");
        let file = create_file(root.path(), "exact.txt");

        let result = list_directory_query(&file.to_string_lossy(), 60, 0).expect("directory query");

        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].name, "exact.txt");
        assert_eq!(result.files[0].source, "file");
    }

    #[test]
    fn user_typing_a_plain_query_falls_through_to_fuzzy_search() {
        assert!(resolve_directory_query_in("report", None).is_none());
        assert!(resolve_directory_query_in("", None).is_none());
        assert!(resolve_directory_query_in("  report  ", None).is_none());
    }

    #[test]
    fn user_typing_a_missing_path_gets_an_empty_result_instead_of_fuzzy_rows() {
        let root = tempfile::tempdir().expect("temp directory");
        let missing = root.path().join("does-not-exist");

        let result =
            list_directory_query(&missing.to_string_lossy(), 60, 0).expect("path-shaped query");

        assert!(result.files.is_empty());
        assert_eq!(result.total_files, 0);
    }

    #[test]
    fn user_gets_directory_results_in_stable_pages() {
        let root = tempfile::tempdir().expect("temp directory");
        create_file(root.path(), "a.txt");
        create_file(root.path(), "b.txt");
        create_file(root.path(), "c.txt");

        let first = list_directory_query(&root.path().to_string_lossy(), 2, 0).expect("first page");
        let second =
            list_directory_query(&root.path().to_string_lossy(), 2, 2).expect("second page");

        assert_eq!(
            first
                .files
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            vec!["a.txt", "b.txt"]
        );
        assert_eq!(first.next_offset, 2);
        assert_eq!(
            second
                .files
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            vec!["c.txt"]
        );
        assert_eq!(second.next_offset, 4);
    }

    #[test]
    fn user_can_type_a_quoted_directory_path() {
        let root = tempfile::tempdir().expect("temp directory");
        create_file(root.path(), "quoted.txt");

        let result = list_directory_query(&format!("\"{}\"", root.path().display()), 60, 0)
            .expect("directory query");

        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].name, "quoted.txt");
    }
}
