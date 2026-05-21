// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//匹配与评分工具。
//!
//提供来源根目录归类、名称/路径归一化、分词、打分与去重键构建能力。

use super::state::{SearchRoot, ShortcutRecord};
use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

pub(super) fn collect_search_roots() -> Vec<SearchRoot> {
    // 仅收集常见快捷方式来源目录；不存在的环境变量自动跳过。
    let mut roots = Vec::new();

    let mut push_root = |path: PathBuf, source: &'static str| {
        let mut prefix_norm = normalize_path_str(&path.to_string_lossy());
        if !prefix_norm.ends_with('\\') {
            prefix_norm.push('\\');
        }
        roots.push(SearchRoot {
            prefix_norm,
            source,
        });
    };

    if let Ok(app_data) = std::env::var("APPDATA") {
        push_root(
            PathBuf::from(app_data).join(r"Microsoft\Windows\Start Menu\Programs"),
            "start_menu_user",
        );
    }

    if let Ok(program_data) = std::env::var("ProgramData") {
        push_root(
            PathBuf::from(program_data).join(r"Microsoft\Windows\Start Menu\Programs"),
            "start_menu_common",
        );
    }

    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        push_root(PathBuf::from(user_profile).join("Desktop"), "desktop_user");
    }

    if let Ok(public_profile) = std::env::var("PUBLIC") {
        push_root(
            PathBuf::from(public_profile).join("Desktop"),
            "desktop_public",
        );
    }

    roots
}

pub(super) fn classify_shortcut_source<'a>(path_norm: &str, roots: &'a [SearchRoot]) -> &'a str {
    // 最长前缀匹配由 roots 顺序保证；未命中回落为通用 shortcut_file。
    roots
        .iter()
        .find(|root| path_norm.starts_with(&root.prefix_norm))
        .map(|root| root.source)
        .unwrap_or("shortcut_file")
}

pub(super) fn display_name_from_path(path: &Path, is_shortcut: bool) -> Option<String> {
    let name = if is_shortcut {
        path.file_stem()?.to_str()?
    } else {
        path.file_name()?.to_str()?
    };
    normalize_search_term(name)
}

pub(super) fn tokenize_query(query: &str) -> Vec<String> {
    query
        .to_lowercase()
        .split_whitespace()
        .filter(|token| !token.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

pub(super) fn build_result_dedupe_key(record: &ShortcutRecord) -> String {
    if record.target_norm.is_empty() || record.target_norm == record.name_norm {
        return record.name_norm.clone();
    }
    format!("{}|{}", record.name_norm, record.target_norm)
}

pub(super) fn score_shortcut_record(record: &ShortcutRecord, tokens: &[String]) -> Option<i32> {
    // 所有 token 均至少命中 name/target 之一才保留该记录。
    let mut score = 0;
    let mut name_hits = 0_usize;
    let mut target_hits = 0_usize;

    for token in tokens {
        let name_score = score_token(token, &record.name_norm);
        let target_score = if record.target_norm.is_empty() {
            None
        } else {
            score_token(token, &record.target_norm)
        };

        match (name_score, target_score) {
            (Some(name_score), Some(target_score)) => {
                if name_score >= target_score {
                    score += name_score + 35;
                    name_hits += 1;
                } else {
                    score += target_score;
                    target_hits += 1;
                }
                score += 20;
            }
            (Some(name_score), None) => {
                score += name_score + 25;
                name_hits += 1;
            }
            (None, Some(target_score)) => {
                score += target_score;
                target_hits += 1;
            }
            (None, None) => return None,
        }
    }

    if name_hits == tokens.len() {
        score += 90;
    }
    if target_hits == tokens.len() {
        score += 40;
    }
    if name_hits > 0 && target_hits > 0 {
        score += 30;
    }

    Some(score)
}

fn is_subsequence(needle: &str, haystack: &str) -> bool {
    let mut needle_chars = needle.chars();
    let mut current = needle_chars.next();
    if current.is_none() {
        return true;
    }

    for ch in haystack.chars() {
        if Some(ch) == current {
            current = needle_chars.next();
            if current.is_none() {
                return true;
            }
        }
    }

    false
}

fn score_token(token: &str, normalized_text: &str) -> Option<i32> {
    // 分值优先级：全等 > 前缀 > 子串 > 子序列。
    if token.is_empty() {
        return Some(0);
    }

    if normalized_text == token {
        return Some(560);
    }

    if normalized_text.starts_with(token) {
        return Some(460 - token.len().min(120) as i32);
    }

    if let Some(position) = normalized_text.find(token) {
        return Some(340 - position.min(220) as i32);
    }

    if is_subsequence(token, normalized_text) {
        return Some(200 - (normalized_text.len().saturating_sub(token.len())).min(140) as i32);
    }

    None
}

pub(super) fn normalize_for_match(value: &str) -> String {
    value.to_lowercase()
}

pub(super) fn is_lnk_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("lnk"))
}

pub(super) fn extract_shortcut_name(path: &Path) -> Option<String> {
    let name = path.file_stem()?.to_str()?.trim();
    if name.is_empty() {
        return None;
    }
    Some(name.to_string())
}

pub(super) fn normalize_search_term(term: &str) -> Option<String> {
    let trimmed = term.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

pub(super) fn normalize_path_str(path: &str) -> String {
    path.replace('/', "\\").to_lowercase()
}

pub(super) fn read_file_fingerprint(path: &Path) -> (u64, u64) {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return (0, 0),
    };

    let file_size = metadata.len();
    let modified_secs = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    (modified_secs, file_size)
}
