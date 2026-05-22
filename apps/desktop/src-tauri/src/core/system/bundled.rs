// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 内置二进制 provisioning。
//!
//! 编译时通过 build.rs 把外部工具二进制嵌入可执行文件，
//! 运行时首次调用释放到 assets/bin 目录，供 bash 工具直接调用。
//!
//! 每个二进制通过 embedded_* 子模块提供三常量（FILENAME / SHA256 / BYTES），
//! 本模块的 `resolve` 统一处理验证、释放和目录缓存。

use std::{path::PathBuf, sync::OnceLock};

use sha2::{Digest, Sha256};

use super::paths::{app_directory_path, AppDirectory};

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut output, "{byte:02x}");
    }
    output
}

/// 一次性验证并释放嵌入的二进制到 assets/bin。
///
/// 返回二进制所在目录路径，可直接追加到 PATH。
/// 如果嵌入字节为空（当前平台不在清单中）或写入失败，返回 None。
fn resolve(filename: &str, sha256: &str, bytes: &[u8]) -> Option<PathBuf> {
    if bytes.is_empty() || filename.is_empty() {
        return None;
    }

    let bin_dir = match app_directory_path(AppDirectory::AssetsBin) {
        Ok(dir) => dir,
        Err(_) => return None,
    };
    if std::fs::create_dir_all(&bin_dir).is_err() {
        return None;
    }
    let binary_path = bin_dir.join(filename);

    let needs_write = if binary_path.exists() {
        match std::fs::read(&binary_path) {
            Ok(existing) => sha256_hex(&existing) != sha256,
            Err(_) => true,
        }
    } else {
        true
    };

    if needs_write {
        if std::fs::write(&binary_path, bytes).is_err() {
            return None;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::metadata(&binary_path) {
                let mut perms = meta.permissions();
                perms.set_mode(0o755);
                let _ = std::fs::set_permissions(&binary_path, perms);
            }
        }
    }

    Some(bin_dir)
}

// ── rtk ───────────────────────────────────────────────────────────────

static RTK_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

/// 获取已验证的 rtk 二进制目录（带 OnceLock 缓存，仅首次调用时执行验证）。
///
/// 返回的目录路径可直接追加到 PATH，使 rtk 对 bash 工具可见。
/// 不支持的平台或验证失败时返回 None。
pub fn get_bundled_rtk_directory() -> Option<&'static PathBuf> {
    RTK_DIR
        .get_or_init(|| {
            resolve(
                super::embedded_rtk::BUNDLED_RTK_FILENAME,
                super::embedded_rtk::BUNDLED_RTK_SHA256,
                super::embedded_rtk::BUNDLED_RTK_BYTES,
            )
        })
        .as_ref()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_hex_matches_known_digest() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn sha256_hex_produces_64_char_lowercase() {
        let result = sha256_hex(b"hello world");
        assert_eq!(result.len(), 64);
        assert!(result
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));
    }

    #[test]
    fn sha256_hex_different_inputs_differ() {
        assert_ne!(sha256_hex(b"aaa"), sha256_hex(b"bbb"));
    }

    #[test]
    fn resolve_returns_none_for_empty_bytes() {
        assert!(resolve("rg", "abc", &[]).is_none());
    }

    #[test]
    fn resolve_returns_none_for_empty_filename() {
        assert!(resolve("", "abc", b"data").is_none());
    }
}
