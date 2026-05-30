// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
};

use super::types::{
    BuiltInApplyPatchExecutionRequest, BuiltInApplyPatchExecutionResponse,
    BuiltInApplyPatchFileChange, BuiltInApplyPatchFilePreview, BuiltInApplyPatchOperation,
};

const MAX_PREVIEW_CHARS: usize = 4000;
const MAX_DELETE_PREVIEW_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
enum PatchOperation {
    Add {
        path: String,
        lines: Vec<String>,
    },
    Delete {
        path: String,
    },
    Update {
        path: String,
        move_to: Option<String>,
        hunks: Vec<PatchHunk>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PatchHunk {
    lines: Vec<HunkLine>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum HunkLine {
    Context(String),
    Remove(String),
    Add(String),
}

#[derive(Debug, Clone)]
struct ResolvedPatchPath {
    absolute: PathBuf,
    display: String,
}

pub fn apply_patch(
    request: BuiltInApplyPatchExecutionRequest,
) -> Result<BuiltInApplyPatchExecutionResponse, String> {
    let root = resolve_workspace_root(&request.working_directory)?;
    let operations = parse_patch(&request.patch)?;
    if operations.is_empty() {
        return Err("Patch contains no operations".to_string());
    }

    let mut staged_files = HashMap::<PathBuf, Option<String>>::new();
    let mut changed_files = Vec::<BuiltInApplyPatchFileChange>::new();

    for operation in operations {
        match operation {
            PatchOperation::Add { path, lines } => {
                let target = resolve_patch_path(&root, &path)?;
                if virtual_file_exists(&staged_files, &target.absolute) {
                    return Err(format!("Target file already exists: {}", target.display));
                }

                let next_content = format_added_file_content(&lines);
                let preview = build_text_preview(None, Some(next_content.as_str()));
                staged_files.insert(target.absolute, Some(next_content));
                changed_files.push(BuiltInApplyPatchFileChange {
                    path: target.display,
                    new_path: None,
                    operation: BuiltInApplyPatchOperation::Add,
                    preview: Some(preview),
                });
            }
            PatchOperation::Delete { path } => {
                let target = resolve_patch_path(&root, &path)?;
                ensure_virtual_file_exists(&staged_files, &target)?;
                let preview = build_delete_preview(&staged_files, &target)?;
                staged_files.insert(target.absolute, None);
                changed_files.push(BuiltInApplyPatchFileChange {
                    path: target.display,
                    new_path: None,
                    operation: BuiltInApplyPatchOperation::Delete,
                    preview: Some(preview),
                });
            }
            PatchOperation::Update {
                path,
                move_to,
                hunks,
            } => {
                let target = resolve_patch_path(&root, &path)?;
                ensure_virtual_file_exists(&staged_files, &target)?;
                let current_content = read_virtual_file(&staged_files, &target)?;
                let next_content = apply_hunks(&current_content, &hunks, &target.display)?;
                let preview =
                    build_text_preview(Some(current_content.as_str()), Some(next_content.as_str()));

                if let Some(next_path) = move_to {
                    let destination = resolve_patch_path(&root, &next_path)?;
                    if destination.absolute != target.absolute
                        && virtual_file_exists(&staged_files, &destination.absolute)
                    {
                        return Err(format!(
                            "Move destination already exists: {}",
                            destination.display
                        ));
                    }

                    staged_files.insert(target.absolute, None);
                    staged_files.insert(destination.absolute, Some(next_content));
                    changed_files.push(BuiltInApplyPatchFileChange {
                        path: target.display,
                        new_path: Some(destination.display),
                        operation: BuiltInApplyPatchOperation::Move,
                        preview: Some(preview),
                    });
                } else {
                    staged_files.insert(target.absolute, Some(next_content));
                    changed_files.push(BuiltInApplyPatchFileChange {
                        path: target.display,
                        new_path: None,
                        operation: BuiltInApplyPatchOperation::Update,
                        preview: Some(preview),
                    });
                }
            }
        }
    }

    write_staged_files(&staged_files)?;
    let working_directory = format_workspace_display_path(&root);
    let summary = format_patch_summary(&working_directory, &changed_files);

    Ok(BuiltInApplyPatchExecutionResponse {
        success: true,
        working_directory,
        changed_files,
        summary,
    })
}

fn parse_patch(input: &str) -> Result<Vec<PatchOperation>, String> {
    let normalized = input.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines: Vec<&str> = normalized.split('\n').collect();
    while lines.last() == Some(&"") {
        lines.pop();
    }

    if lines.first() != Some(&"*** Begin Patch") {
        return Err("Invalid patch: expected '*** Begin Patch'".to_string());
    }

    if lines.last() != Some(&"*** End Patch") {
        return Err("Invalid patch: expected '*** End Patch'".to_string());
    }

    let mut operations = Vec::new();
    let mut index = 1;
    while index + 1 < lines.len() {
        let line = lines[index];
        if let Some(path) = line.strip_prefix("*** Add File: ") {
            index += 1;
            let mut content = Vec::new();
            while index + 1 < lines.len() && !is_operation_marker(lines[index]) {
                let content_line = lines[index];
                let Some(line_content) = content_line.strip_prefix('+') else {
                    return Err(format!(
                        "Invalid Add File line for {}: expected '+' prefix",
                        path
                    ));
                };
                content.push(line_content.to_string());
                index += 1;
            }
            operations.push(PatchOperation::Add {
                path: path.trim().to_string(),
                lines: content,
            });
            continue;
        }

        if let Some(path) = line.strip_prefix("*** Delete File: ") {
            operations.push(PatchOperation::Delete {
                path: path.trim().to_string(),
            });
            index += 1;
            continue;
        }

        if let Some(path) = line.strip_prefix("*** Update File: ") {
            index += 1;
            let mut move_to = None;
            if index + 1 < lines.len() {
                if let Some(next_path) = lines[index].strip_prefix("*** Move to: ") {
                    move_to = Some(next_path.trim().to_string());
                    index += 1;
                }
            }

            let mut hunks = Vec::new();
            while index + 1 < lines.len() && !is_operation_marker(lines[index]) {
                let hunk_header = lines[index];
                if !hunk_header.starts_with("@@") {
                    return Err(format!(
                        "Invalid Update File block for {}: expected '@@' hunk header",
                        path
                    ));
                }
                index += 1;

                let mut hunk_lines = Vec::new();
                while index + 1 < lines.len()
                    && !is_operation_marker(lines[index])
                    && !lines[index].starts_with("@@")
                {
                    let hunk_line = lines[index];
                    if hunk_line == "*** End of File" {
                        index += 1;
                        continue;
                    }

                    let Some(prefix) = hunk_line.chars().next() else {
                        return Err(format!(
                            "Invalid hunk line for {}: empty lines must use a prefix",
                            path
                        ));
                    };
                    let text = hunk_line[prefix.len_utf8()..].to_string();
                    match prefix {
                        ' ' => hunk_lines.push(HunkLine::Context(text)),
                        '-' => hunk_lines.push(HunkLine::Remove(text)),
                        '+' => hunk_lines.push(HunkLine::Add(text)),
                        _ => {
                            return Err(format!(
                                "Invalid hunk line for {}: expected ' ', '-' or '+' prefix",
                                path
                            ));
                        }
                    }
                    index += 1;
                }

                if hunk_lines.is_empty() {
                    return Err(format!("Invalid hunk for {}: hunk is empty", path));
                }
                hunks.push(PatchHunk { lines: hunk_lines });
            }

            if move_to.is_none() && hunks.is_empty() {
                return Err(format!(
                    "Invalid Update File block for {}: missing hunks",
                    path
                ));
            }

            operations.push(PatchOperation::Update {
                path: path.trim().to_string(),
                move_to,
                hunks,
            });
            continue;
        }

        return Err(format!("Invalid patch operation header: {}", line));
    }

    Ok(operations)
}

fn is_operation_marker(line: &str) -> bool {
    line.starts_with("*** Add File: ")
        || line.starts_with("*** Update File: ")
        || line.starts_with("*** Delete File: ")
}

fn resolve_workspace_root(working_directory: &str) -> Result<PathBuf, String> {
    let trimmed = working_directory.trim();
    if trimmed.is_empty() {
        return Err("ApplyPatch requires a workingDirectory".to_string());
    }

    fs::canonicalize(trimmed)
        .map_err(|error| format!("Failed to resolve workingDirectory {}: {}", trimmed, error))
}

fn resolve_patch_path(root: &Path, raw_path: &str) -> Result<ResolvedPatchPath, String> {
    let relative_path = validate_relative_patch_path(raw_path)?;
    let candidate = root.join(&relative_path);

    let boundary_path = if candidate.exists() {
        candidate.as_path()
    } else {
        nearest_existing_parent(&candidate).ok_or_else(|| {
            format!(
                "No existing parent directory inside workspace for path: {}",
                format_display_path(raw_path)
            )
        })?
    };
    let canonical_boundary = fs::canonicalize(boundary_path).map_err(|error| {
        format!(
            "Failed to resolve path boundary for {}: {}",
            format_display_path(raw_path),
            error
        )
    })?;

    if !canonical_boundary.starts_with(root) {
        return Err(format!(
            "Unsafe path outside workspace: {}",
            format_display_path(raw_path)
        ));
    }

    let absolute = if candidate.exists() {
        fs::canonicalize(&candidate).map_err(|error| {
            format!(
                "Failed to resolve path {}: {}",
                format_display_path(raw_path),
                error
            )
        })?
    } else {
        candidate
    };

    if absolute.exists() {
        let metadata = fs::metadata(&absolute).map_err(|error| {
            format!(
                "Failed to inspect path {}: {}",
                format_display_path(raw_path),
                error
            )
        })?;
        if metadata.is_dir() {
            return Err(format!(
                "Patch path points to a directory, not a file: {}",
                format_display_path(raw_path)
            ));
        }
    }

    Ok(ResolvedPatchPath {
        absolute,
        display: format_display_path(raw_path),
    })
}

fn validate_relative_patch_path(raw_path: &str) -> Result<PathBuf, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("Patch path cannot be empty".to_string());
    }

    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Err(format!(
            "Patch paths must be relative to workingDirectory: {}",
            format_display_path(trimmed)
        ));
    }

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(segment) => normalized.push(segment),
            Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) | Component::RootDir => {
                return Err(format!(
                    "Unsafe patch path outside workspace: {}",
                    format_display_path(trimmed)
                ));
            }
        }
    }

    if normalized.as_os_str().is_empty() {
        return Err("Patch path cannot be empty".to_string());
    }

    Ok(normalized)
}

fn nearest_existing_parent(path: &Path) -> Option<&Path> {
    let mut current = path.parent();
    while let Some(parent) = current {
        if parent.exists() {
            return Some(parent);
        }
        current = parent.parent();
    }
    None
}

fn format_display_path(path: &str) -> String {
    path.trim().replace('\\', "/")
}

fn format_workspace_display_path(path: &Path) -> String {
    normalize_windows_verbatim_path(&path.to_string_lossy())
}

fn normalize_windows_verbatim_path(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{}", rest);
    }

    if let Some(rest) = path.strip_prefix(r"\\?\") {
        return rest.to_string();
    }

    path.to_string()
}

fn virtual_file_exists(staged_files: &HashMap<PathBuf, Option<String>>, path: &Path) -> bool {
    match staged_files.get(path) {
        Some(Some(_)) => true,
        Some(None) => false,
        None => path.exists(),
    }
}

fn ensure_virtual_file_exists(
    staged_files: &HashMap<PathBuf, Option<String>>,
    target: &ResolvedPatchPath,
) -> Result<(), String> {
    if virtual_file_exists(staged_files, &target.absolute) {
        return Ok(());
    }

    Err(format!("Target file not found: {}", target.display))
}

fn read_virtual_file(
    staged_files: &HashMap<PathBuf, Option<String>>,
    target: &ResolvedPatchPath,
) -> Result<String, String> {
    match staged_files.get(&target.absolute) {
        Some(Some(content)) => Ok(content.clone()),
        Some(None) => Err(format!("Target file not found: {}", target.display)),
        None => fs::read_to_string(&target.absolute)
            .map_err(|error| format!("Failed to read {}: {}", target.display, error)),
    }
}

fn build_delete_preview(
    staged_files: &HashMap<PathBuf, Option<String>>,
    target: &ResolvedPatchPath,
) -> Result<BuiltInApplyPatchFilePreview, String> {
    if let Some(Some(content)) = staged_files.get(&target.absolute) {
        return Ok(build_text_preview(Some(content.as_str()), None));
    }

    let metadata = fs::metadata(&target.absolute)
        .map_err(|error| format!("Failed to inspect {}: {}", target.display, error))?;
    if metadata.len() > MAX_DELETE_PREVIEW_BYTES {
        return Ok(BuiltInApplyPatchFilePreview {
            before_content: None,
            after_content: None,
            before_truncated: false,
            after_truncated: false,
            is_binary: false,
            omitted: true,
        });
    }

    let bytes = fs::read(&target.absolute)
        .map_err(|error| format!("Failed to read {}: {}", target.display, error))?;
    if bytes.contains(&0) {
        return Ok(BuiltInApplyPatchFilePreview {
            before_content: None,
            after_content: None,
            before_truncated: false,
            after_truncated: false,
            is_binary: true,
            omitted: false,
        });
    }

    match String::from_utf8(bytes) {
        Ok(content) => Ok(build_text_preview(Some(content.as_str()), None)),
        Err(_) => Ok(BuiltInApplyPatchFilePreview {
            before_content: None,
            after_content: None,
            before_truncated: false,
            after_truncated: false,
            is_binary: true,
            omitted: false,
        }),
    }
}

fn build_text_preview(before: Option<&str>, after: Option<&str>) -> BuiltInApplyPatchFilePreview {
    let (before_content, before_truncated) = truncate_preview_text(before);
    let (after_content, after_truncated) = truncate_preview_text(after);

    BuiltInApplyPatchFilePreview {
        before_content,
        after_content,
        before_truncated,
        after_truncated,
        is_binary: false,
        omitted: false,
    }
}

fn truncate_preview_text(content: Option<&str>) -> (Option<String>, bool) {
    let Some(content) = content else {
        return (None, false);
    };

    let total_chars = content.chars().count();
    if total_chars <= MAX_PREVIEW_CHARS {
        return (Some(content.to_string()), false);
    }

    (
        Some(content.chars().take(MAX_PREVIEW_CHARS).collect()),
        true,
    )
}

fn format_added_file_content(lines: &[String]) -> String {
    if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    }
}

fn apply_hunks(content: &str, hunks: &[PatchHunk], display_path: &str) -> Result<String, String> {
    if hunks.is_empty() {
        return Ok(content.to_string());
    }

    let (mut lines, has_final_newline) = split_content_lines(content);
    let mut search_start = 0;

    for hunk in hunks {
        let old_lines = hunk_old_lines(hunk);
        if old_lines.is_empty() {
            return Err(format!(
                "Invalid hunk for {}: at least one context or removed line is required",
                display_path
            ));
        }

        let new_lines = hunk_new_lines(hunk);
        let new_len = new_lines.len();
        let Some(match_index) = find_sequence(&lines, &old_lines, search_start)
            .or_else(|| find_sequence(&lines, &old_lines, 0))
        else {
            return Err(format!("Hunk context not found in {}", display_path));
        };

        lines.splice(match_index..match_index + old_lines.len(), new_lines);
        search_start = match_index + new_len;
    }

    Ok(join_content_lines(&lines, has_final_newline))
}

fn hunk_old_lines(hunk: &PatchHunk) -> Vec<String> {
    hunk.lines
        .iter()
        .filter_map(|line| match line {
            HunkLine::Context(text) | HunkLine::Remove(text) => Some(text.clone()),
            HunkLine::Add(_) => None,
        })
        .collect()
}

fn hunk_new_lines(hunk: &PatchHunk) -> Vec<String> {
    hunk.lines
        .iter()
        .filter_map(|line| match line {
            HunkLine::Context(text) | HunkLine::Add(text) => Some(text.clone()),
            HunkLine::Remove(_) => None,
        })
        .collect()
}

fn split_content_lines(content: &str) -> (Vec<String>, bool) {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let has_final_newline = normalized.ends_with('\n');
    let body = normalized.strip_suffix('\n').unwrap_or(&normalized);
    if body.is_empty() {
        return (Vec::new(), has_final_newline);
    }

    (
        body.split('\n').map(|line| line.to_string()).collect(),
        has_final_newline,
    )
}

fn join_content_lines(lines: &[String], has_final_newline: bool) -> String {
    let mut content = lines.join("\n");
    if has_final_newline && !content.is_empty() {
        content.push('\n');
    }
    content
}

fn find_sequence(lines: &[String], needle: &[String], start: usize) -> Option<usize> {
    if needle.is_empty() || needle.len() > lines.len() {
        return None;
    }

    let max_start = lines.len() - needle.len();
    let start_index = start.min(max_start);
    (start_index..=max_start).find(|index| lines[*index..*index + needle.len()] == *needle)
}

fn write_staged_files(staged_files: &HashMap<PathBuf, Option<String>>) -> Result<(), String> {
    for (path, content) in staged_files {
        if let Some(content) = content {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    format!(
                        "Failed to create parent directory for {:?}: {}",
                        path, error
                    )
                })?;
            }
            fs::write(path, content)
                .map_err(|error| format!("Failed to write {:?}: {}", path, error))?;
        }
    }

    for (path, content) in staged_files {
        if content.is_none() && path.exists() {
            fs::remove_file(path)
                .map_err(|error| format!("Failed to delete {:?}: {}", path, error))?;
        }
    }

    Ok(())
}

fn format_patch_summary(
    working_directory: &str,
    changes: &[BuiltInApplyPatchFileChange],
) -> String {
    let mut lines = vec![format!("已在 {} 应用补丁", working_directory)];
    for change in changes {
        match change.operation {
            BuiltInApplyPatchOperation::Move => lines.push(format!(
                "- 移动 {} 到 {}",
                change.path,
                change.new_path.as_deref().unwrap_or("")
            )),
            BuiltInApplyPatchOperation::Add => lines.push(format!("- 新增 {}", change.path)),
            BuiltInApplyPatchOperation::Update => lines.push(format!("- 修改 {}", change.path)),
            BuiltInApplyPatchOperation::Delete => lines.push(format!("- 删除 {}", change.path)),
        }
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    fn request(root: &Path, patch: &str) -> BuiltInApplyPatchExecutionRequest {
        BuiltInApplyPatchExecutionRequest {
            patch: patch.to_string(),
            working_directory: root.to_string_lossy().to_string(),
        }
    }

    #[test]
    fn adds_file() {
        let temp = tempdir().unwrap();
        let response = apply_patch(request(
            temp.path(),
            "*** Begin Patch\n*** Add File: src/new.txt\n+hello\n+world\n*** End Patch",
        ))
        .unwrap();

        assert_eq!(
            fs::read_to_string(temp.path().join("src/new.txt")).unwrap(),
            "hello\nworld\n"
        );
        let preview = response.changed_files[0].preview.as_ref().unwrap();
        assert_eq!(preview.before_content, None);
        assert_eq!(preview.after_content.as_deref(), Some("hello\nworld\n"));
    }

    #[test]
    fn updates_file() {
        let temp = tempdir().unwrap();
        fs::write(temp.path().join("file.txt"), "one\ntwo\nthree\n").unwrap();

        let response = apply_patch(request(
            temp.path(),
            "*** Begin Patch\n*** Update File: file.txt\n@@\n one\n-two\n+TWO\n three\n*** End Patch",
        ))
        .unwrap();

        assert_eq!(
            fs::read_to_string(temp.path().join("file.txt")).unwrap(),
            "one\nTWO\nthree\n"
        );
        let preview = response.changed_files[0].preview.as_ref().unwrap();
        assert_eq!(preview.before_content.as_deref(), Some("one\ntwo\nthree\n"));
        assert_eq!(preview.after_content.as_deref(), Some("one\nTWO\nthree\n"));
    }

    #[test]
    fn deletes_file() {
        let temp = tempdir().unwrap();
        fs::write(temp.path().join("file.txt"), "delete me\n").unwrap();

        let response = apply_patch(request(
            temp.path(),
            "*** Begin Patch\n*** Delete File: file.txt\n*** End Patch",
        ))
        .unwrap();

        assert!(!temp.path().join("file.txt").exists());
        let preview = response.changed_files[0].preview.as_ref().unwrap();
        assert_eq!(preview.before_content.as_deref(), Some("delete me\n"));
        assert_eq!(preview.after_content, None);
    }

    #[test]
    fn moves_file() {
        let temp = tempdir().unwrap();
        fs::write(temp.path().join("old.txt"), "old\n").unwrap();

        let response = apply_patch(request(
            temp.path(),
            "*** Begin Patch\n*** Update File: old.txt\n*** Move to: nested/new.txt\n*** End Patch",
        ))
        .unwrap();

        assert!(!temp.path().join("old.txt").exists());
        assert_eq!(
            fs::read_to_string(temp.path().join("nested/new.txt")).unwrap(),
            "old\n"
        );
        let preview = response.changed_files[0].preview.as_ref().unwrap();
        assert_eq!(preview.before_content.as_deref(), Some("old\n"));
        assert_eq!(preview.after_content.as_deref(), Some("old\n"));
    }

    #[test]
    fn rejects_invalid_syntax() {
        let temp = tempdir().unwrap();
        let error =
            apply_patch(request(temp.path(), "*** Begin Patch\nbad\n*** End Patch")).unwrap_err();

        assert!(error.contains("Invalid patch operation header"));
    }

    #[test]
    fn rejects_missing_update_target() {
        let temp = tempdir().unwrap();
        let error = apply_patch(request(
            temp.path(),
            "*** Begin Patch\n*** Update File: missing.txt\n@@\n-old\n+new\n*** End Patch",
        ))
        .unwrap_err();

        assert!(error.contains("Target file not found"));
    }

    #[test]
    fn rejects_conflicting_hunk() {
        let temp = tempdir().unwrap();
        fs::write(temp.path().join("file.txt"), "actual\n").unwrap();

        let error = apply_patch(request(
            temp.path(),
            "*** Begin Patch\n*** Update File: file.txt\n@@\n-expected\n+new\n*** End Patch",
        ))
        .unwrap_err();

        assert!(error.contains("Hunk context not found"));
    }

    #[test]
    fn rejects_unsafe_parent_path() {
        let temp = tempdir().unwrap();
        let error = apply_patch(request(
            temp.path(),
            "*** Begin Patch\n*** Add File: ../outside.txt\n+nope\n*** End Patch",
        ))
        .unwrap_err();

        assert!(error.contains("Unsafe patch path"));
    }

    #[test]
    fn normalizes_windows_verbatim_display_path() {
        assert_eq!(normalize_windows_verbatim_path(r"\\?\E:\Temp"), r"E:\Temp");
    }

    #[test]
    fn normalizes_windows_verbatim_unc_display_path() {
        assert_eq!(
            normalize_windows_verbatim_path(r"\\?\UNC\server\share\repo"),
            r"\\server\share\repo"
        );
    }
}
