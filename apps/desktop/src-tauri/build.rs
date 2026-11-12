use flate2::read::GzDecoder;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

use quote::ToTokens;
use tauri_codegen::embedded_assets::{AssetOptions, EmbeddedAssets};

/// Points the shared bundled-binary cache at a specific directory.
const BUNDLED_BINARY_CACHE_ENV: &str = "TOUCHAI_BUNDLED_BINARY_CACHE";

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
        // MSVC writes diagnostics in the console code page, so on a zh-CN host its
        // warnings reach this script's stdout as GBK bytes. Cargo passes that stdout
        // through unchanged, which makes the build-script output invalid UTF-8 and
        // keeps a compiler cache from storing it. Everything.c is vendored and emits
        // exactly these two warnings, so silencing them for this file keeps the log
        // ASCII without hiding errors or warnings from code we own.
        cc::Build::new()
            .file("vendor/everything/Everything.c")
            .flag_if_supported("-wd4100")
            .flag_if_supported("-wd4133")
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
/// - manifest 路径：`resources/binaries.json` 中的对应条目
/// - 缓存目录：`target/{name}-cache/{version}/{triple}`
/// - 共享缓存：`<user cache>/touchai/bundled-binaries/{name}/{version}/{triple}`
/// - 生成产物：`{OUT_DIR}/{name}-binary.rs`
///   其中常量名为 `BUNDLED_{NAME_UPPER}_FILENAME` / `_SHA256` / `_BYTES`
fn prepare_bundled(name: &str) -> Result<(), Box<dyn std::error::Error>> {
    let manifest_path = PathBuf::from("resources/binaries.json");
    println!("cargo:rerun-if-changed={}", manifest_path.display());

    let mut resources: std::collections::BTreeMap<String, serde_json::Value> =
        serde_json::from_slice(&fs::read(&manifest_path)?)?;
    let manifest: BundledManifest = serde_json::from_value(
        resources
            .remove(name)
            .ok_or(format!("missing bundled resource {name}"))?,
    )?;
    let target_triple = std::env::var("TARGET")?;
    let out_dir = PathBuf::from(std::env::var("OUT_DIR")?);
    let cache_dir = cargo_target_dir(&out_dir)?
        .join(format!("{name}-cache"))
        .join(&manifest.version)
        .join(&target_triple);

    if let Some(target) = manifest.targets.get(&target_triple) {
        // The manifest is the only source of truth for what may be embedded. A
        // target without an extracted-binary digest cannot be verified from the
        // cache, and the empty module keeps the build honest instead of shipping
        // bytes nothing can check.
        if target.binary_digest.is_empty() {
            generate_empty_asset_module(name, &out_dir)?;
            return Ok(());
        }

        let binary_path =
            materialize_binary(name, &manifest.version, &target_triple, target, &cache_dir)?;
        generate_asset_module(name, &out_dir, &binary_path, &target.binary_digest)?;
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
    version: &str,
    target_triple: &str,
    target: &BundledTarget,
    cache_dir: &Path,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    fs::create_dir_all(cache_dir)?;
    let file_name = Path::new(&target.archive_path)
        .file_name()
        .ok_or(format!("{name}: missing archive file name"))?;
    let binary_path = cache_dir.join(file_name);

    if verified_binary(&binary_path, target)? {
        return Ok(binary_path);
    }

    // A fresh worktree or target directory would otherwise download the same
    // release again, and an unreachable host would fail it. Reuse the copy this
    // machine already verified instead.
    if let Some(shared) = shared_binary_path(name, version, target_triple, file_name) {
        if copy_shared_binary(&shared, &binary_path, target) {
            return Ok(binary_path);
        }
    }

    let bytes = download_archive(&target.url)?;
    if bytes.len() as u64 != target.size {
        return Err(format!("{name}: download size mismatch for {}", target.url).into());
    }

    let actual_digest = sha256_hex(&bytes);
    if actual_digest != target.digest {
        return Err(format!("{name}: digest mismatch for {}", target.url).into());
    }

    let extracted = extract_target_binary(name, &bytes, &target.format, &target.archive_path)?;
    let extracted_digest = sha256_hex(&extracted);
    if extracted_digest != target.binary_digest {
        return Err(format!(
            "{name}: extracted binary digest mismatch for {}: expected {}, got {extracted_digest}",
            target.url, target.binary_digest
        )
        .into());
    }

    fs::write(&binary_path, &extracted)?;
    store_shared_binary(name, version, target_triple, file_name, &extracted);
    Ok(binary_path)
}

fn verified_binary(
    path: &Path,
    target: &BundledTarget,
) -> Result<bool, Box<dyn std::error::Error>> {
    if !path.exists() || target.binary_digest.is_empty() {
        return Ok(false);
    }

    // Only the extracted binary may live at this path. Accepting the archive
    // digest here would let an archive that was dropped there pass as an
    // executable and be embedded without ever being extracted.
    Ok(sha256_file(path)? == target.binary_digest)
}

/// Copy the machine-wide release into this target, or report a miss.
///
/// The shared cache is an optimisation, so an unreadable, missing or partially
/// written file is a miss and the caller downloads instead. The copy is verified
/// as well, because the shared file can change between the check and the copy;
/// embedding bytes that never matched the manifest would be a silent corruption.
fn copy_shared_binary(shared: &Path, destination: &Path, target: &BundledTarget) -> bool {
    if !verified_binary(shared, target).unwrap_or(false) {
        return false;
    }

    if fs::copy(shared, destination).is_err() {
        return false;
    }

    verified_binary(destination, target).unwrap_or(false)
}

/// Path of the machine-wide copy, keyed by name, release version and target.
///
/// `TOUCHAI_BUNDLED_BINARY_CACHE` overrides the location, which also lets CI and
/// offline machines pre-seed one directory instead of reaching the host.
fn shared_binary_path(
    name: &str,
    version: &str,
    target_triple: &str,
    file_name: &std::ffi::OsStr,
) -> Option<PathBuf> {
    let root = match std::env::var_os(BUNDLED_BINARY_CACHE_ENV) {
        Some(root) if !root.is_empty() => PathBuf::from(root),
        _ => dirs::cache_dir()?.join("touchai").join("bundled-binaries"),
    };

    Some(
        root.join(name)
            .join(version)
            .join(target_triple)
            .join(file_name),
    )
}

/// Best effort: a read-only or missing home directory must not fail the build.
///
/// The write is atomic so a concurrent build never copies a half-written file.
fn store_shared_binary(
    name: &str,
    version: &str,
    target_triple: &str,
    file_name: &std::ffi::OsStr,
    bytes: &[u8],
) {
    let Some(path) = shared_binary_path(name, version, target_triple, file_name) else {
        return;
    };
    let Some(parent) = path.parent() else {
        return;
    };

    if fs::create_dir_all(parent).is_err() {
        return;
    }

    let Ok(mut temporary) = tempfile::NamedTempFile::new_in(parent) else {
        return;
    };

    if temporary.write_all(bytes).is_ok() {
        let _ = temporary.persist(&path);
    }
}

/// Fetch an archive with a bounded wait and a few retries.
///
/// The binary host is reached over the public internet, so one dropped
/// connection must not fail the build and a stalled one must not hang it. Each
/// attempt is capped, transient failures are retried, and the final error keeps
/// the underlying `ureq` text so the release retry wrapper can classify it.
///
/// The timeouts are per operation, not for the whole transfer: a download that
/// keeps making progress on a slow link is allowed to finish, while a connection
/// that stops sending data fails one attempt and moves on to the next.
fn download_archive(url: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    const ATTEMPTS: u32 = 3;
    const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
    const READ_TIMEOUT: Duration = Duration::from_secs(30);

    let agent = ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout_read(READ_TIMEOUT)
        .timeout_write(READ_TIMEOUT)
        .build();

    let mut last_reason = String::new();

    for attempt in 1..=ATTEMPTS {
        match fetch_archive(&agent, url) {
            Ok(bytes) => return Ok(bytes),
            Err(DownloadFailure::Permanent(error)) => return Err(error),
            Err(DownloadFailure::Transient(reason)) => {
                last_reason = reason;
                if attempt < ATTEMPTS {
                    std::thread::sleep(Duration::from_secs(u64::from(attempt)));
                }
            }
        }
    }

    Err(format!("download failed after {ATTEMPTS} attempts: {last_reason}").into())
}

/// One attempt, body included.
///
/// Reading the body is part of the attempt so a reset or stall in the middle of
/// the transfer is retried like a connection failure, and the error names the
/// URL the way the release wrapper expects.
enum DownloadFailure {
    /// A later attempt can succeed.
    Transient(String),
    /// Retrying cannot change the answer.
    Permanent(Box<dyn std::error::Error>),
}

fn fetch_archive(agent: &ureq::Agent, url: &str) -> Result<Vec<u8>, DownloadFailure> {
    let response = agent.get(url).call().map_err(|error| {
        if is_transient_download_error(&error) {
            DownloadFailure::Transient(error.to_string())
        } else {
            DownloadFailure::Permanent(error.into())
        }
    })?;

    let mut bytes = Vec::new();
    response
        .into_reader()
        .read_to_end(&mut bytes)
        .map_err(|error| DownloadFailure::Transient(format!("{url}: {error}")))?;

    Ok(bytes)
}

/// Whether another attempt can succeed where this one failed.
///
/// A transport error is worth retrying; a server error or a throttle is worth
/// retrying; a 404 or a digest mismatch is not.
fn is_transient_download_error(error: &ureq::Error) -> bool {
    match error {
        ureq::Error::Status(status, _) => {
            matches!(*status, 408 | 429) || (500..600).contains(status)
        }
        ureq::Error::Transport(_) => true,
    }
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
