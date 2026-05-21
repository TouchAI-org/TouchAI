// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 内置 rg 二进制 provisioning。
//!
//! 编译时通过 build.rs 把 rg 二进制嵌入可执行文件，
//! 运行时首次调用释放到 assets/bin 目录，供 bash 工具直接调用。

use std::{path::PathBuf, sync::OnceLock};

use sha2::{Digest, Sha256};

use crate::core::system::paths::{app_directory_path, AppDirectory};

use super::embedded_ripgrep::{
    BUNDLED_RIPGREP_BYTES, BUNDLED_RIPGREP_FILENAME, BUNDLED_RIPGREP_SHA256,
};

/// 缓存已验证的 rg 二进制目录，避免每次 bash 执行都重算 SHA-256。
static VERIFIED_BINARY_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut output, "{byte:02x}");
    }
    output
}

/// 一次性验证并释放嵌入的 rg 二进制到 assets/bin。
///
/// 返回 rg 所在目录路径，可直接追加到 PATH 环境变量。
/// 如果嵌入字节为空（当前平台不在清单中）或写入失败，返回 None。
fn verify_and_resolve_binary_dir() -> Option<PathBuf> {
    if BUNDLED_RIPGREP_BYTES.is_empty() || BUNDLED_RIPGREP_FILENAME.is_empty() {
        return None;
    }

    let bin_dir = match app_directory_path(AppDirectory::AssetsBin) {
        Ok(dir) => dir,
        Err(_) => return None,
    };
    if std::fs::create_dir_all(&bin_dir).is_err() {
        return None;
    }
    let binary_path = bin_dir.join(BUNDLED_RIPGREP_FILENAME);

    let needs_write = if binary_path.exists() {
        match std::fs::read(&binary_path) {
            Ok(existing) => sha256_hex(&existing) != BUNDLED_RIPGREP_SHA256,
            Err(_) => true,
        }
    } else {
        true
    };

    if needs_write {
        if std::fs::write(&binary_path, BUNDLED_RIPGREP_BYTES).is_err() {
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

/// 获取已验证的 rg 二进制目录（带 OnceLock 缓存，仅首次调用时执行验证）。
///
/// 返回的目录路径可直接追加到 PATH，使 rg 对 bash 工具可见。
/// 不支持的平台或验证失败时返回 None。
pub fn get_bundled_rg_directory() -> Option<&'static PathBuf> {
    VERIFIED_BINARY_DIR
        .get_or_init(verify_and_resolve_binary_dir)
        .as_ref()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_hex_matches_known_digest() {
        // SHA-256 of empty input
        let result = sha256_hex(b"");
        assert_eq!(
            result,
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
        let a = sha256_hex(b"aaa");
        let b = sha256_hex(b"bbb");
        assert_ne!(a, b);
    }
}
