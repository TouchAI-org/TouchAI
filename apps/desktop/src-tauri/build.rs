use flate2::read::GzDecoder;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    thread,
    time::Duration,
};

use quote::ToTokens;
use tauri_codegen::embedded_assets::{AssetOptions, EmbeddedAssets};

const BUNDLED_DOWNLOAD_MAX_ATTEMPTS: usize = 6;
const BUNDLED_DOWNLOAD_RETRY_BASE_DELAY_MS: u64 = 1_500;
const BUNDLED_DOWNLOAD_RETRY_MAX_DELAY_MS: u64 = 30_000;

#[derive(Debug, Deserialize)]
struct BundledManifest {
    version: String,
    targets: std::collections::BTreeMap<String, BundledTarget>,
}

#[derive(Debug, Deserialize)]
struct BundledTarget {
    size: u64,
    digest: String,
    #[serde(default, alias = "binaryDigest")]
    binary_digest: String,
    format: String,
    #[serde(rename = "archivePath")]
    archive_path: String,
    url: String,
}

fn main() {
    generate_database_embedded_assets().expect("failed to generate embedded database assets");
    prepare_bundled("rtk").expect("failed to prepare bundled rtk");

    #[cfg(target_os = "windows")]
    configure_windows_common_controls_manifest()
        .expect("failed to configure Windows common-controls manifest");

    // Compile Everything SDK C source on Windows
    #[cfg(target_os = "windows")]
    {
        cc::Build::new()
            .file("vendor/everything/Everything.c")
            .compile("everything_sdk");
    }

    tauri_build::build()
}

#[cfg(target_os = "windows")]
fn configure_windows_common_controls_manifest() -> Result<(), Box<dyn std::error::Error>> {
    let manifest_path = PathBuf::from("windows-common-controls.manifest").canonicalize()?;
    emit_rerun_if_changed(&manifest_path)?;

    // Integration-test executables on Windows do not inherit the app manifest that
    // the packaged Tauri binary gets. Explicitly requesting Common Controls v6 keeps
    // GUI-linked test binaries from loading the legacy comctl32 surface and crashing
    // on symbols such as TaskDialogIndirect during process startup.
    println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
    println!(
        "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
        manifest_path.display()
    );

    Ok(())
}

fn generate_database_embedded_assets() -> Result<(), Box<dyn std::error::Error>> {
    let database_root = PathBuf::from("../src/database");
    emit_rerun_if_changed(&database_root.join("drizzle"))?;
    emit_rerun_if_changed(&database_root.join("artifacts"))?;
    let database_root = database_root.canonicalize()?;
    let embedded_root = prepare_database_embedded_asset_root(&database_root)?;

    // 数据库契约需要和前端资源一样走 Tauri 自己的 embedded-assets 编译链路，
    // 这样 release / 绿色版可以保持单文件自包含，而不是退回外部资源目录。
    // 同时只内联运行时真正会读取的 drizzle / artifacts SQL/JSON，避免把 schema、queries、测试文件一起打包进去。
    let assets = EmbeddedAssets::new(
        embedded_root,
        &AssetOptions::new(Default::default()),
        |_, _, _, _| Ok(()),
    )?;

    let output_path = PathBuf::from(std::env::var("OUT_DIR")?).join("database-assets.rs");
    fs::write(output_path, assets.to_token_stream().to_string())?;
    Ok(())
}

fn prepare_database_embedded_asset_root(
    database_root: &Path,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let embedded_root = PathBuf::from(std::env::var("OUT_DIR")?).join("database-contract-assets");
    if embedded_root.exists() {
        fs::remove_dir_all(&embedded_root)?;
    }
    fs::create_dir_all(&embedded_root)?;

    copy_database_contract_directory(
        &database_root.join("drizzle"),
        database_root,
        &embedded_root,
    )?;
    copy_database_contract_directory(
        &database_root.join("artifacts"),
        database_root,
        &embedded_root,
    )?;

    Ok(embedded_root)
}

fn copy_database_contract_directory(
    directory: &Path,
    database_root: &Path,
    embedded_root: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        if path.is_dir() {
            copy_database_contract_directory(&path, database_root, embedded_root)?;
            continue;
        }

        if !is_database_contract_asset(&path) {
            continue;
        }

        let relative_path = path.strip_prefix(database_root)?;
        let target_path = embedded_root.join(relative_path);
        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&path, &target_path)?;
    }

    Ok(())
}

fn is_database_contract_asset(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|extension| extension.to_str()),
        Some("sql" | "json")
    )
}

fn emit_rerun_if_changed(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-changed={}", path.display());
    if path.is_dir() {
        for entry in fs::read_dir(path)? {
            emit_rerun_if_changed(&entry?.path())?;
        }
    }
    Ok(())
}

// ── 通用二进制打包 ───────────────────────────────────────────────────

/// 编译时下载、校验、嵌入一个外部二进制。
///
/// `name` 同时决定：
/// - manifest 路径：`resources/{name}/manifest.json`
/// - 缓存目录：`target/{name}-cache/{version}/{triple}`
/// - 生成产物：`{OUT_DIR}/{name}-binary.rs`
///   其中常量名为 `BUNDLED_{NAME_UPPER}_FILENAME` / `_SHA256` / `_BYTES`
fn prepare_bundled(name: &str) -> Result<(), Box<dyn std::error::Error>> {
    let manifest_path = PathBuf::from(format!("resources/{name}/manifest.json"));
    println!("cargo:rerun-if-changed={}", manifest_path.display());

    let manifest: BundledManifest = serde_json::from_slice(&fs::read(&manifest_path)?)?;
    let target_triple = std::env::var("TARGET")?;
    let out_dir = PathBuf::from(std::env::var("OUT_DIR")?);
    let cache_dir = cargo_target_dir(&out_dir)?
        .join(format!("{name}-cache"))
        .join(&manifest.version)
        .join(&target_triple);

    if let Some(target) = manifest.targets.get(&target_triple) {
        let binary_path = materialize_binary(name, target, &cache_dir)?;
        let binary_hash = if !target.binary_digest.is_empty() {
            target.binary_digest.clone()
        } else {
            sha256_file(&binary_path)?
        };
        generate_asset_module(name, &out_dir, &binary_path, &binary_hash)?;
    } else {
        generate_empty_asset_module(name, &out_dir)?;
    }

    Ok(())
}

fn cargo_target_dir(out_dir: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(target_dir) = std::env::var_os("CARGO_TARGET_DIR") {
        let target_dir = PathBuf::from(target_dir);
        return Ok(if target_dir.is_absolute() {
            target_dir
        } else {
            PathBuf::from(std::env::var("CARGO_MANIFEST_DIR")?).join(target_dir)
        });
    }

    out_dir
        .ancestors()
        .nth(4)
        .map(Path::to_path_buf)
        .ok_or_else(|| {
            format!(
                "failed to resolve Cargo target directory from {}",
                out_dir.display()
            )
            .into()
        })
}

fn materialize_binary(
    name: &str,
    target: &BundledTarget,
    cache_dir: &Path,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    fs::create_dir_all(cache_dir)?;
    let file_name = Path::new(&target.archive_path)
        .file_name()
        .ok_or(format!("{name}: missing archive file name"))?;
    let binary_path = cache_dir.join(file_name);

    if binary_path.exists() {
        let existing_hash = sha256_file(&binary_path)?;
        if existing_hash == target.digest
            || (!target.binary_digest.is_empty() && existing_hash == target.binary_digest)
        {
            return Ok(binary_path);
        }
    }

    let bytes = download_bundled_archive(name, &target.url)?;
    if bytes.len() as u64 != target.size {
        return Err(format!("{name}: download size mismatch for {}", target.url).into());
    }

    let actual_digest = sha256_hex(&bytes);
    if actual_digest != target.digest {
        return Err(format!("{name}: digest mismatch for {}", target.url).into());
    }

    let extracted = extract_target_binary(name, &bytes, &target.format, &target.archive_path)?;
    fs::write(&binary_path, extracted)?;
    Ok(binary_path)
}

fn download_bundled_archive(name: &str, url: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut last_error = None;

    for attempt in 1..=BUNDLED_DOWNLOAD_MAX_ATTEMPTS {
        match download_bundled_archive_once(url) {
            Ok(bytes) => return Ok(bytes),
            Err(error) => {
                last_error = Some(error);
                if attempt < BUNDLED_DOWNLOAD_MAX_ATTEMPTS {
                    let delay_ms = bundled_download_retry_delay_ms(attempt);
                    println!(
                        "cargo:warning={name}: bundled download attempt {attempt}/{BUNDLED_DOWNLOAD_MAX_ATTEMPTS} failed for {url}; retrying in {delay_ms}ms"
                    );
                    thread::sleep(Duration::from_millis(delay_ms));
                }
            }
        }
    }

    Err(format!(
        "{name}: failed to download bundled archive {url} after {BUNDLED_DOWNLOAD_MAX_ATTEMPTS} attempts: {}",
        last_error.unwrap_or_else(|| "unknown error".to_string())
    )
    .into())
}

fn bundled_download_retry_delay_ms(attempt: usize) -> u64 {
    let exponent = attempt.saturating_sub(1).min(4) as u32;
    BUNDLED_DOWNLOAD_RETRY_BASE_DELAY_MS
        .saturating_mul(1_u64 << exponent)
        .min(BUNDLED_DOWNLOAD_RETRY_MAX_DELAY_MS)
}

fn download_bundled_archive_once(url: &str) -> Result<Vec<u8>, String> {
    let response = ureq::get(url)
        .call()
        .map_err(|error| format!("request failed: {error}"))?;
    response
        .into_reader()
        .bytes()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("response body read failed: {error}"))
}

fn generate_asset_module(
    name: &str,
    out_dir: &Path,
    binary_path: &Path,
    digest: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let file_name = binary_path
        .file_name()
        .ok_or(format!("{name}: missing file name"))?
        .to_string_lossy();
    let const_prefix = name.to_uppercase().replace('-', "_");

    fs::write(
        out_dir.join(format!("{name}-binary.rs")),
        format!(
            "pub const BUNDLED_{const_prefix}_FILENAME: &str = {file_name:?};\n\
             pub const BUNDLED_{const_prefix}_SHA256: &str = {digest:?};\n\
             pub static BUNDLED_{const_prefix}_BYTES: &[u8] = include_bytes!(r#\"{path}\"#);\n",
            file_name = file_name,
            digest = digest,
            path = binary_path.canonicalize()?.display()
        ),
    )?;

    Ok(())
}

fn generate_empty_asset_module(
    name: &str,
    out_dir: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let const_prefix = name.to_uppercase().replace('-', "_");

    fs::write(
        out_dir.join(format!("{name}-binary.rs")),
        format!(
            "pub const BUNDLED_{const_prefix}_FILENAME: &str = \"\";\n\
             pub const BUNDLED_{const_prefix}_SHA256: &str = \"\";\n\
             pub static BUNDLED_{const_prefix}_BYTES: &[u8] = &[];\n",
        ),
    )?;

    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, Box<dyn std::error::Error>> {
    Ok(sha256_hex(&fs::read(path)?))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut output, "{byte:02x}");
    }
    output
}

fn extract_target_binary(
    name: &str,
    archive_bytes: &[u8],
    format: &str,
    archive_path: &str,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    match format {
        "zip" => {
            let mut archive = zip::ZipArchive::new(Cursor::new(archive_bytes))?;
            let mut file = archive.by_name(archive_path)?;
            let mut extracted = Vec::new();
            file.read_to_end(&mut extracted)?;
            Ok(extracted)
        }
        "tar.gz" => {
            let decoder = GzDecoder::new(Cursor::new(archive_bytes));
            let mut archive = tar::Archive::new(decoder);
            for entry in archive.entries()? {
                let mut entry = entry?;
                if entry.path()?.to_string_lossy() == archive_path {
                    let mut extracted = Vec::new();
                    entry.read_to_end(&mut extracted)?;
                    return Ok(extracted);
                }
            }
            Err(format!("{name}: missing archive entry {archive_path}").into())
        }
        other => Err(format!("{name}: unsupported archive format: {other}").into()),
    }
}
