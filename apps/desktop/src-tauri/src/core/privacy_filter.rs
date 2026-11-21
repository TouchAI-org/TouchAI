use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures::StreamExt;
use models::{PrivacyFilterModelId, PrivacyFilterModelSource};
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Runtime};
use tokenizers::{Encoding, PaddingParams, PaddingStrategy, Tokenizer, TruncationParams};
use tokio::io::AsyncWriteExt;
use tokio::sync::watch;

mod gguf;
pub mod models;
pub mod records;

const MODEL_REVISION: &str = "7216b6a3b897ef903d4b1ba367ae6fb95b0fa5e4";
const MODEL_DIRECTORY_NAME: &str = "astrlink-guard-7216b6a3b897";
pub const DOWNLOAD_PROGRESS_EVENT: &str = "privacy-filter-download-progress";
const MAX_MODEL_WINDOW: usize = 512;
const MODEL_WINDOW_STRIDE: usize = 128;
const MAX_MODEL_TOKENS: usize = 16_384;
const MAX_MODEL_WINDOWS: usize = 64;
const MAX_REQUEST_TEXTS: usize = 4096;
const MAX_REQUEST_TEXT_BYTES: usize = MAX_MODEL_TOKENS * 4;
const MODEL_READ_TIMEOUT: Duration = Duration::from_secs(60);

fn inference_threads() -> usize {
    std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .min(4)
}

#[derive(Clone, Copy)]
pub(super) struct ModelFile {
    name: &'static str,
    size: u64,
    sha256: &'static str,
}

const MODEL_FILES: &[ModelFile] = &[
    ModelFile {
        name: "model_int8.onnx",
        size: 330_781,
        sha256: "0a070d3113615e33ba3b84d6bd486f663a377c04c4b056e7381732179f51832a",
    },
    ModelFile {
        name: "model_int8.onnx_data",
        size: 37_124_608,
        sha256: "0ba34216ceead01e0ae2dfd8e46d52b67e7aee80b04f722d9b758613a91c0067",
    },
    ModelFile {
        name: "tokenizer.json",
        size: 1_502_881,
        sha256: "0cf3b235ef125658015a6c8026a5fe6f28088bf825101a990ec18a10200feef4",
    },
    ModelFile {
        name: "config.json",
        size: 1_804,
        sha256: "2c20003590d642e273c03c4c7c82d9849fa75f64bf29a71ec0a0c9a20ba4a150",
    },
    ModelFile {
        name: "labels.json",
        size: 768,
        sha256: "1a81b6cdcedbc8481b956109df303a84fbbef84cc2229bf3a26c80237dc1f120",
    },
];

#[derive(Default)]
struct DownloadSnapshot {
    model_id: Option<PrivacyFilterModelId>,
    cancellation: Option<watch::Sender<bool>>,
    downloaded_bytes: u64,
    current_file: Option<String>,
}

#[derive(Clone, Default)]
pub struct PrivacyFilterRuntime {
    download: Arc<Mutex<DownloadSnapshot>>,
    pub records: Arc<records::PrivacyProtectionRecords>,
    operation: Arc<tokio::sync::Mutex<()>>,
    gguf: Arc<tokio::sync::Mutex<Option<gguf::GgufProcess>>>,
    child: gguf::ChildHandle,
    idle_cleanup: Arc<AtomicBool>,
}

impl PrivacyFilterRuntime {
    pub fn with_records(records: records::PrivacyProtectionRecords) -> Self {
        Self {
            records: Arc::new(records),
            ..Self::default()
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyFilterModelStatus {
    pub model_id: PrivacyFilterModelId,
    pub installed: bool,
    pub downloading: bool,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub current_file: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyFilterDownloadProgress {
    pub model_id: PrivacyFilterModelId,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub current_file: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyFilterSpan {
    pub start: usize,
    pub end: usize,
    pub kind: String,
    pub score: f32,
}

impl PrivacyFilterRuntime {
    fn begin_download(
        &self,
        model_id: PrivacyFilterModelId,
    ) -> Result<watch::Receiver<bool>, String> {
        let (sender, receiver) = watch::channel(false);
        let mut download = self
            .download
            .lock()
            .map_err(|_| "Privacy model download state is unavailable".to_string())?;
        if download.cancellation.is_some() {
            return Err("Privacy model download is already running".to_string());
        }
        download.cancellation = Some(sender);
        download.model_id = Some(model_id);
        download.downloaded_bytes = 0;
        download.current_file = None;
        Ok(receiver)
    }

    fn finish_download(&self) {
        if let Ok(mut download) = self.download.lock() {
            download.cancellation = None;
            download.model_id = None;
            download.downloaded_bytes = 0;
            download.current_file = None;
        }
    }

    fn update_progress(&self, downloaded_bytes: u64, current_file: &str) {
        if let Ok(mut download) = self.download.lock() {
            download.downloaded_bytes = downloaded_bytes;
            download.current_file = Some(current_file.to_string());
        }
    }

    pub fn cancel_download(&self, model_id: PrivacyFilterModelId) -> Result<(), String> {
        let download = self
            .download
            .lock()
            .map_err(|_| "Privacy model download state is unavailable".to_string())?;
        if let Some(cancellation) = &download.cancellation {
            if download.model_id != Some(model_id) {
                return Ok(());
            }
            let _ = cancellation.send(true);
        }
        Ok(())
    }

    fn snapshot(
        &self,
        model_id: PrivacyFilterModelId,
    ) -> Result<(bool, u64, Option<String>), String> {
        let download = self
            .download
            .lock()
            .map_err(|_| "Privacy model download state is unavailable".to_string())?;
        if download.model_id != Some(model_id) {
            return Ok((false, 0, None));
        }
        Ok((
            download.cancellation.is_some(),
            download.downloaded_bytes,
            download.current_file.clone(),
        ))
    }
}

pub fn model_directory(model_id: PrivacyFilterModelId) -> Result<PathBuf, String> {
    use crate::core::system::paths::{app_directory_path, AppDirectory};
    Ok(app_directory_path(AppDirectory::Data)?
        .join("privacy-filter")
        .join(model_id.spec().directory))
}

pub fn model_status(
    runtime: &PrivacyFilterRuntime,
    model_id: PrivacyFilterModelId,
) -> Result<PrivacyFilterModelStatus, String> {
    let directory = model_directory(model_id)?;
    let spec = model_id.spec();
    let installed = spec
        .files
        .iter()
        .all(|file| file_size_matches(&directory.join(file.name), file.size))
        && (!model_id.needs_runtime()
            || gguf::installed(
                &directory
                    .parent()
                    .ok_or("Invalid model directory")?
                    .join(gguf::RUNTIME_DIRECTORY),
            ));
    let (downloading, downloaded_bytes, current_file) = runtime.snapshot(model_id)?;
    Ok(PrivacyFilterModelStatus {
        model_id,
        installed,
        downloading,
        downloaded_bytes: if installed {
            spec.total_bytes()
        } else {
            downloaded_bytes
        },
        total_bytes: spec.total_bytes(),
        current_file,
    })
}

pub async fn download_model<R: Runtime>(
    app: AppHandle<R>,
    runtime: PrivacyFilterRuntime,
    model_id: PrivacyFilterModelId,
    source: PrivacyFilterModelSource,
) -> Result<(), String> {
    let cancellation = runtime.begin_download(model_id)?;
    let result = download_model_files(&app, &runtime, model_id, source, cancellation).await;
    runtime.finish_download();
    let _ = app.emit(
        DOWNLOAD_PROGRESS_EVENT,
        PrivacyFilterDownloadProgress {
            model_id,
            downloaded_bytes: 0,
            total_bytes: 0,
            current_file: String::new(),
        },
    );
    result
}

async fn download_model_files<R: Runtime>(
    app: &AppHandle<R>,
    runtime: &PrivacyFilterRuntime,
    model_id: PrivacyFilterModelId,
    source: PrivacyFilterModelSource,
    mut cancellation: watch::Receiver<bool>,
) -> Result<(), String> {
    let directory = model_directory(model_id)?;
    let parent = directory.parent().ok_or("Invalid model directory")?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| error.to_string())?;
    remove_stale_downloads(parent).await?;
    let staging = parent.join(format!("download-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir(&staging)
        .await
        .map_err(|error| error.to_string())?;
    let client = reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(MODEL_READ_TIMEOUT)
        .user_agent(concat!("TouchAI/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| error.to_string())?;
    let spec = model_id.spec();
    let mut runtime_promoted = false;
    let result = async {
        if model_id.needs_runtime() {
            let asset = gguf::runtime_asset()
                .ok_or("Privacy model runtime is unavailable on this platform")?;
            let runtime_directory = parent.join(gguf::RUNTIME_DIRECTORY);
            if !gguf::installed(&runtime_directory) {
                let runtime_staging = staging.join("runtime");
                tokio::fs::create_dir(&runtime_staging)
                    .await
                    .map_err(|error| error.to_string())?;
                let url = format!(
                    "https://github.com/yetone/magpie/releases/download/pf-v4/pf-serve-{}.zip",
                    asset.target
                );
                download_file(
                    &client,
                    asset.file,
                    &[url],
                    &runtime_staging.join(asset.file.name),
                    &mut cancellation,
                    |bytes| {
                        runtime.update_progress(bytes, "runtime.zip");
                        let _ = app.emit(
                            DOWNLOAD_PROGRESS_EVENT,
                            PrivacyFilterDownloadProgress {
                                model_id,
                                downloaded_bytes: bytes,
                                total_bytes: spec.total_bytes() + asset.file.size,
                                current_file: "runtime.zip".into(),
                            },
                        );
                    },
                )
                .await?;
                let unpack_directory = runtime_staging.clone();
                tokio::task::spawn_blocking(move || gguf::unpack(&unpack_directory))
                    .await
                    .map_err(|error| error.to_string())??;
                if *cancellation.borrow() {
                    return Err("Privacy model download cancelled".into());
                }
            }
        }
        let mut before = 0u64;
        for file in spec.files {
            download_file(
                &client,
                *file,
                &spec.urls(*file, source),
                &staging.join(file.name),
                &mut cancellation,
                |bytes| {
                    runtime.update_progress(before + bytes, file.name);
                    let _ = app.emit(
                        DOWNLOAD_PROGRESS_EVENT,
                        PrivacyFilterDownloadProgress {
                            model_id,
                            downloaded_bytes: before + bytes,
                            total_bytes: spec.total_bytes(),
                            current_file: file.name.into(),
                        },
                    );
                },
            )
            .await?;
            before += file.size;
        }
        if *cancellation.borrow() {
            return Err("Privacy model download cancelled".into());
        }
        let _operation = runtime.operation.lock().await;
        let runtime_staging = staging.join("runtime");
        if runtime_staging.exists() {
            let runtime_directory = parent.join(gguf::RUNTIME_DIRECTORY);
            if runtime_directory.exists() {
                if let Some(process) = runtime.gguf.lock().await.take() {
                    process.stop().await;
                }
                tokio::fs::remove_dir_all(&runtime_directory)
                    .await
                    .map_err(|error| error.to_string())?;
            }
            tokio::fs::rename(runtime_staging, runtime_directory)
                .await
                .map_err(|error| error.to_string())?;
            runtime_promoted = true;
        }
        if directory.exists() {
            if let Some(process) = runtime.gguf.lock().await.take() {
                process.stop().await;
            }
            *loaded_model()
                .lock()
                .map_err(|_| "Privacy model runtime is unavailable")? = None;
            tokio::fs::remove_dir_all(&directory)
                .await
                .map_err(|error| error.to_string())?;
        }
        tokio::fs::rename(&staging, &directory)
            .await
            .map_err(|error| error.to_string())?;
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        if runtime_promoted
            && [PrivacyFilterModelId::OpenAi, PrivacyFilterModelId::OpenMed]
                .iter()
                .all(|id| !parent.join(id.spec().directory).exists())
        {
            let _ = tokio::fs::remove_dir_all(parent.join(gguf::RUNTIME_DIRECTORY)).await;
        }
    }
    result
}

async fn download_file(
    client: &reqwest::Client,
    file: ModelFile,
    sources: &[String],
    target: &Path,
    cancellation: &mut watch::Receiver<bool>,
    mut progress: impl FnMut(u64),
) -> Result<(), String> {
    use tokio::io::AsyncSeekExt;
    if *cancellation.borrow() {
        return Err("Privacy model download cancelled".into());
    }
    let mut output = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(target)
        .await
        .map_err(|error| error.to_string())?;
    let mut written = 0u64;
    let mut hasher = Sha256::new();
    let mut failure = "No model download source is available".to_string();
    let mut integrity_failure = None;
    let mut last_progress = std::time::Instant::now();
    progress(0);
    for (attempt, source) in sources.iter().cycle().take(sources.len() * 4).enumerate() {
        if *cancellation.borrow() {
            failure = "Privacy model download cancelled".into();
            break;
        }
        if attempt >= sources.len() {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(500 * (attempt as u64).min(8))) => {},
                _ = cancellation.changed() => { failure = "Privacy model download cancelled".into(); break; },
            }
        }
        let result = async {
            while written < file.size {
                let start = written;
                let requested_end = (start + 16 * 1024 * 1024).min(file.size) - 1;
                let response = tokio::select! {
                    result = client.get(source).header(reqwest::header::ACCEPT_ENCODING, "identity")
                        .header(reqwest::header::RANGE, format!("bytes={start}-{requested_end}")).send() => result.map_err(|_| format!("Could not download {}", file.name))?,
                    _ = cancellation.changed() => return Err("Privacy model download cancelled".to_string()),
                }.error_for_status().map_err(|_| format!("Download source is unavailable for {}", file.name))?;
                let expected_end = if response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
                    let expected_range = format!("bytes {start}-{requested_end}/{}", file.size);
                    if response.headers().get(reqwest::header::CONTENT_RANGE).and_then(|value| value.to_str().ok()) != Some(expected_range.as_str()) {
                        return Err(format!("Unexpected download range for {}", file.name));
                    }
                    requested_end + 1
                } else if start == 0 {
                    file.size
                } else {
                    // A source that ignores Range cannot be appended to an interrupted download.
                    written = 0;
                    hasher = Sha256::new();
                    output.set_len(0).await.map_err(|error| error.to_string())?;
                    output.seek(std::io::SeekFrom::Start(0)).await.map_err(|error| error.to_string())?;
                    return Err(format!("Download source does not support resuming {}", file.name));
                };
                if response.content_length().is_some_and(|length| length != expected_end - start) {
                    return Err(format!("Unexpected size for {}", file.name));
                }
                let mut body = response.bytes_stream();
                loop {
                    let next = tokio::select! {
                        chunk = tokio::time::timeout(MODEL_READ_TIMEOUT, body.next()) => chunk.map_err(|_| format!("Download stalled for {}", file.name))?,
                        _ = cancellation.changed() => return Err("Privacy model download cancelled".to_string()),
                    };
                    let Some(chunk) = next else { break; };
                    let chunk = chunk.map_err(|_| format!("Incomplete download for {}", file.name))?;
                    if written.saturating_add(chunk.len() as u64) > expected_end { return Err(format!("Unexpected size for {}", file.name)); }
                    output.write_all(&chunk).await.map_err(|error| error.to_string())?;
                    hasher.update(&chunk);
                    written += chunk.len() as u64;
                    if last_progress.elapsed() >= Duration::from_millis(200) || written == file.size {
                        progress(written);
                        last_progress = std::time::Instant::now();
                    }
                }
                if written != expected_end { return Err(format!("Incomplete download for {}", file.name)); }
            }
            if digest_hex(hasher.clone()) != file.sha256 { return Err(format!("Checksum verification failed for {}", file.name)); }
            output.sync_all().await.map_err(|error| error.to_string())?;
            Ok(())
        }.await;
        match result {
            Ok(()) => return Ok(()),
            Err(error) => {
                failure = error;
                if *cancellation.borrow() {
                    break;
                }
                if written == file.size {
                    integrity_failure = Some(failure.clone());
                    written = 0;
                    hasher = Sha256::new();
                    output.set_len(0).await.map_err(|error| error.to_string())?;
                    output
                        .seek(std::io::SeekFrom::Start(0))
                        .await
                        .map_err(|error| error.to_string())?;
                }
            }
        }
    }
    drop(output);
    tokio::fs::remove_file(target)
        .await
        .map_err(|error| format!("Could not discard an incomplete model file: {error}"))?;
    if *cancellation.borrow() {
        Err("Privacy model download cancelled".into())
    } else {
        Err(integrity_failure.unwrap_or(failure))
    }
}

async fn remove_stale_downloads(parent_directory: &Path) -> Result<(), String> {
    let mut entries = tokio::fs::read_dir(parent_directory)
        .await
        .map_err(|error| error.to_string())?;
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| error.to_string())?
    {
        let file_name = entry.file_name();
        let Some(uuid) = file_name
            .to_str()
            .and_then(|name| name.strip_prefix("download-"))
        else {
            continue;
        };
        if uuid::Uuid::parse_str(uuid).is_err() {
            continue;
        }
        if entry
            .file_type()
            .await
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            tokio::fs::remove_dir_all(entry.path())
                .await
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub async fn delete_model(
    runtime: &PrivacyFilterRuntime,
    model_id: PrivacyFilterModelId,
) -> Result<(), String> {
    let _operation = runtime.operation.lock().await;
    if runtime
        .download
        .lock()
        .map_err(|_| "Privacy model download state is unavailable")?
        .cancellation
        .is_some()
    {
        return Err("Cancel the privacy model download before deleting a model".into());
    }
    if model_id == PrivacyFilterModelId::AstrLinkGuard {
        *loaded_model()
            .lock()
            .map_err(|_| "Privacy model runtime is unavailable")? = None;
    } else {
        let mut loaded = runtime.gguf.lock().await;
        if loaded
            .as_ref()
            .is_some_and(|process| process.model_id == model_id)
        {
            if let Some(process) = loaded.take() {
                process.stop().await;
            }
        }
    }
    let directory = model_directory(model_id)?;
    if directory.exists() {
        tokio::fs::remove_dir_all(&directory)
            .await
            .map_err(|error| error.to_string())?;
    }
    if model_id.needs_runtime() {
        let root = directory.parent().ok_or("Invalid model directory")?;
        if [PrivacyFilterModelId::OpenAi, PrivacyFilterModelId::OpenMed]
            .iter()
            .all(|id| !root.join(id.spec().directory).exists())
        {
            let runtime_directory = root.join(gguf::RUNTIME_DIRECTORY);
            if runtime_directory.exists() {
                tokio::fs::remove_dir_all(runtime_directory)
                    .await
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

impl PrivacyFilterRuntime {
    pub fn stop_child(&self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.start_kill();
            }
        }
    }

    pub async fn release_models(&self) -> Result<(), String> {
        let _operation = self.operation.lock().await;
        if let Some(process) = self.gguf.lock().await.take() {
            process.stop().await;
        }
        *loaded_model()
            .lock()
            .map_err(|_| "Privacy model runtime is unavailable")? = None;
        Ok(())
    }

    fn schedule_idle_cleanup(&self) {
        if self
            .idle_cleanup
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let runtime = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(30)).await;
                let Ok(_operation) = runtime.operation.try_lock() else {
                    continue;
                };
                let mut loaded = runtime.gguf.lock().await;
                if loaded
                    .as_ref()
                    .is_some_and(|process| process.last_used.elapsed() >= Duration::from_secs(120))
                {
                    if let Some(process) = loaded.take() {
                        process.stop().await;
                    }
                }
                if loaded.is_none() {
                    runtime.idle_cleanup.store(false, Ordering::Release);
                    break;
                }
            }
        });
    }
}

pub async fn detect_with_model(
    runtime: &PrivacyFilterRuntime,
    texts: Vec<String>,
    directory: PathBuf,
    model_id: PrivacyFilterModelId,
) -> Result<Vec<Vec<PrivacyFilterSpan>>, String> {
    if texts.len() > MAX_REQUEST_TEXTS
        || texts
            .iter()
            .fold(0usize, |total, text| total.saturating_add(text.len()))
            > MAX_REQUEST_TEXT_BYTES
    {
        return Err("Privacy scan input is too large".into());
    }
    let _operation = runtime.operation.lock().await;
    if !model_id.needs_runtime() {
        if let Some(process) = runtime.gguf.lock().await.take() {
            process.stop().await;
        }
        return tokio::task::spawn_blocking(move || detect(texts, directory))
            .await
            .map_err(|_| "Local privacy scan failed".to_string())?;
    }
    *loaded_model()
        .lock()
        .map_err(|_| "Privacy model runtime is unavailable")? = None;
    let mut loaded = runtime.gguf.lock().await;
    if loaded
        .as_ref()
        .is_none_or(|process| process.model_id != model_id)
    {
        if let Some(process) = loaded.take() {
            process.stop().await;
        }
        let runtime_directory = directory
            .parent()
            .ok_or("Invalid model directory")?
            .join(gguf::RUNTIME_DIRECTORY);
        *loaded = Some(
            gguf::GgufProcess::load(
                model_id,
                directory,
                runtime_directory,
                runtime.child.clone(),
            )
            .await?,
        );
    }
    let result = loaded
        .as_mut()
        .ok_or("Privacy model runtime is unavailable")?
        .detect(&texts)
        .await;
    if result.is_err() {
        if let Some(process) = loaded.take() {
            process.stop().await;
        }
    }
    runtime.schedule_idle_cleanup();
    result
}

pub fn detect(
    texts: Vec<String>,
    directory: PathBuf,
) -> Result<Vec<Vec<PrivacyFilterSpan>>, String> {
    if texts.len() > MAX_REQUEST_TEXTS {
        return Err("Privacy scan input is too large".to_string());
    }
    let total_bytes = texts
        .iter()
        .fold(0usize, |total, text| total.saturating_add(text.len()));
    if total_bytes > MAX_REQUEST_TEXT_BYTES {
        return Err("Privacy scan input is too large".to_string());
    }
    if !directory.exists() {
        return Err("The selected privacy model is not installed".into());
    }

    let model = loaded_model();
    let mut guard = model
        .lock()
        .map_err(|_| "Privacy model runtime is unavailable".to_string())?;
    if guard.is_none() {
        *guard = Some(LocalPrivacyModel::load(&directory)?);
    }
    let loaded = guard
        .as_mut()
        .ok_or_else(|| "Privacy model runtime is unavailable".to_string())?;
    let encodings = texts
        .iter()
        .map(|text| loaded.encode_text(text))
        .collect::<Result<Vec<_>, _>>()?;
    ensure_model_token_budget(encodings.iter().map(unique_token_count))?;
    if encodings
        .iter()
        .map(|encoding| 1 + encoding.get_overflowing().len())
        .sum::<usize>()
        > MAX_MODEL_WINDOWS
    {
        return Err("Privacy scan input exceeds the model work limit".to_string());
    }
    texts
        .iter()
        .zip(&encodings)
        .map(|(text, encoding)| loaded.detect_text(text, encoding))
        .collect()
}

fn loaded_model() -> &'static Mutex<Option<LocalPrivacyModel>> {
    static LOADED_MODEL: OnceLock<Mutex<Option<LocalPrivacyModel>>> = OnceLock::new();
    LOADED_MODEL.get_or_init(|| Mutex::new(None))
}

struct LocalPrivacyModel {
    session: Session,
    tokenizer: Tokenizer,
    labels: Vec<String>,
}

impl LocalPrivacyModel {
    fn load(directory: &Path) -> Result<Self, String> {
        for file in MODEL_FILES {
            verify_model_file(&directory.join(file.name), *file)?;
        }
        let label_file =
            std::fs::read(directory.join("labels.json")).map_err(|error| error.to_string())?;
        let label_payload: Value =
            serde_json::from_slice(&label_file).map_err(|error| error.to_string())?;
        let mut labels = label_payload["id2label"]
            .as_object()
            .ok_or_else(|| "Privacy model labels are invalid".to_string())?
            .iter()
            .filter_map(|(id, label)| {
                Some((id.parse::<usize>().ok()?, label.as_str()?.to_string()))
            })
            .collect::<Vec<_>>();
        labels.sort_by_key(|(id, _)| *id);
        let labels = labels
            .into_iter()
            .map(|(_, label)| label)
            .collect::<Vec<_>>();
        if labels.len() != 21 {
            return Err("Privacy model label map is incomplete".to_string());
        }

        let mut tokenizer = Tokenizer::from_file(directory.join("tokenizer.json"))
            .map_err(|error| error.to_string())?;
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: MAX_MODEL_WINDOW,
                stride: MODEL_WINDOW_STRIDE,
                ..Default::default()
            }))
            .map_err(|error| error.to_string())?;
        tokenizer.with_padding(Some(PaddingParams {
            strategy: PaddingStrategy::Fixed(MAX_MODEL_WINDOW),
            ..Default::default()
        }));

        // The published INT8 graph uses ONNX Runtime's QAttention operator.
        let session = Session::builder()
            .map_err(|error| error.to_string())?
            .with_intra_threads(inference_threads())
            .map_err(|error| error.to_string())?
            .with_inter_threads(1)
            .map_err(|error| error.to_string())?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|error| error.to_string())?
            .commit_from_file(directory.join("model_int8.onnx"))
            .map_err(|error| error.to_string())?;

        Ok(Self {
            session,
            tokenizer,
            labels,
        })
    }

    fn encode_text(&self, text: &str) -> Result<Encoding, String> {
        self.tokenizer
            .encode(text, true)
            .map_err(|error| error.to_string())
    }

    fn detect_text(
        &mut self,
        text: &str,
        encoding: &Encoding,
    ) -> Result<Vec<PrivacyFilterSpan>, String> {
        if text.is_empty() {
            return Ok(Vec::new());
        }
        let windows = std::iter::once(encoding)
            .chain(encoding.get_overflowing().iter())
            .collect::<Vec<_>>();

        let mut spans = Vec::new();
        for window in windows {
            let input_ids = window
                .get_ids()
                .iter()
                .map(|token| i64::from(*token))
                .collect::<Vec<_>>();
            let attention_mask = window
                .get_attention_mask()
                .iter()
                .map(|token| i64::from(*token))
                .collect::<Vec<_>>();
            let token_type_ids = window
                .get_type_ids()
                .iter()
                .map(|token| i64::from(*token))
                .collect::<Vec<_>>();
            let tensors = [
                ("input_ids", input_ids),
                ("attention_mask", attention_mask),
                ("token_type_ids", token_type_ids),
            ]
            .into_iter()
            .map(|(name, values)| {
                Tensor::from_array(([1usize, MAX_MODEL_WINDOW], values.into_boxed_slice()))
                    .map(|tensor| (name, tensor))
                    .map_err(|error| error.to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
            let outputs = self
                .session
                .run(tensors)
                .map_err(|error| error.to_string())?;
            let output = outputs
                .values()
                .next()
                .ok_or_else(|| "Privacy model returned no output".to_string())?;
            let (shape, values) = output
                .try_extract_tensor::<f32>()
                .map_err(|error| error.to_string())?;
            if shape.len() != 3
                || shape[0] != 1
                || shape[1] < 0
                || shape[2] != self.labels.len() as i64
            {
                return Err("Privacy model output shape is invalid".to_string());
            }
            let offsets = window.get_offsets();
            let mut active: Option<DecodedSpan> = None;
            for token_index in 0..(shape[1] as usize).min(offsets.len()) {
                let (byte_start, byte_end) = offsets[token_index];
                if byte_end <= byte_start {
                    continue;
                }
                let row_start = token_index * self.labels.len();
                let (label_index, score) =
                    softmax_argmax(&values[row_start..row_start + self.labels.len()]);
                let label = self
                    .labels
                    .get(label_index)
                    .map(String::as_str)
                    .unwrap_or("O");
                let (prefix, kind) = match label.split_once('-') {
                    Some((prefix, kind)) if prefix == "B" || prefix == "I" => (prefix, kind),
                    _ => {
                        if let Some(span) = active.take() {
                            spans.push(span.into_public(text));
                        }
                        continue;
                    }
                };
                if prefix == "B" || active.as_ref().is_some_and(|span| span.kind != kind) {
                    if let Some(span) = active.take() {
                        spans.push(span.into_public(text));
                    }
                    active = Some(DecodedSpan {
                        byte_start,
                        byte_end,
                        kind: kind.to_string(),
                        score,
                    });
                } else if let Some(span) = active.as_mut() {
                    span.byte_end = byte_end;
                    span.score = span.score.min(score);
                } else {
                    active = Some(DecodedSpan {
                        byte_start,
                        byte_end,
                        kind: kind.to_string(),
                        score,
                    });
                }
            }
            if let Some(span) = active.take() {
                spans.push(span.into_public(text));
            }
        }

        spans.sort_by(|left, right| {
            left.start
                .cmp(&right.start)
                .then(left.end.cmp(&right.end))
                .then(left.kind.cmp(&right.kind))
        });
        spans.dedup_by(|right, left| {
            left.start == right.start && left.end == right.end && left.kind == right.kind
        });
        Ok(spans)
    }
}

fn unique_token_count(encoding: &Encoding) -> usize {
    let overflowing = encoding.get_overflowing();
    let token_count = std::iter::once(encoding)
        .chain(overflowing.iter())
        .map(|window| {
            window
                .get_attention_mask()
                .iter()
                .filter(|mask| **mask != 0)
                .count()
        })
        .sum::<usize>();
    token_count.saturating_sub(overflowing.len() * MODEL_WINDOW_STRIDE)
}

fn ensure_model_token_budget(token_counts: impl IntoIterator<Item = usize>) -> Result<(), String> {
    let total = token_counts
        .into_iter()
        .fold(0usize, |total, count| total.saturating_add(count));
    if total > MAX_MODEL_TOKENS {
        return Err("Privacy scan input exceeds the model token limit".to_string());
    }
    Ok(())
}

struct DecodedSpan {
    byte_start: usize,
    byte_end: usize,
    kind: String,
    score: f32,
}

impl DecodedSpan {
    fn into_public(self, text: &str) -> PrivacyFilterSpan {
        let (start, end) = clean_span_boundaries(text, self.byte_start, self.byte_end, &self.kind);
        PrivacyFilterSpan {
            start: byte_offset_to_utf16(text, start),
            end: byte_offset_to_utf16(text, end),
            kind: self.kind,
            score: self.score,
        }
    }
}

fn softmax_argmax(logits: &[f32]) -> (usize, f32) {
    let best_index = logits
        .iter()
        .enumerate()
        .max_by(|left, right| left.1.total_cmp(right.1))
        .map(|(index, _)| index)
        .unwrap_or(0);
    let max = logits.get(best_index).copied().unwrap_or(0.0);
    let denominator = logits.iter().map(|value| (value - max).exp()).sum::<f32>();
    let score = if denominator > 0.0 {
        (max - max).exp() / denominator
    } else {
        0.0
    };
    (best_index, score)
}

fn clean_span_boundaries(text: &str, start: usize, end: usize, kind: &str) -> (usize, usize) {
    let mut end = end.min(text.len());
    if kind == "url" {
        while end > start {
            let last = text[..end].chars().next_back().unwrap_or_default();
            if !matches!(last, '.' | ',' | ';' | ':' | '!' | '?' | ')' | ']' | '}') {
                break;
            }
            end -= last.len_utf8();
        }
    } else if kind == "ip_address" {
        while end > start && matches!(text[..end].chars().next_back(), Some('.' | ',' | ';')) {
            end -= text[..end]
                .chars()
                .next_back()
                .unwrap_or_default()
                .len_utf8();
        }
    }
    (start.min(end), end)
}

fn byte_offset_to_utf16(text: &str, byte_offset: usize) -> usize {
    text.get(..byte_offset.min(text.len()))
        .unwrap_or_default()
        .encode_utf16()
        .count()
}

fn verify_model_file(path: &Path, expected: ModelFile) -> Result<(), String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() != expected.size {
        return Err(format!("Unexpected size for {}", expected.name));
    }
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 128 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    let actual = digest_hex(hasher);
    if actual != expected.sha256 {
        return Err(format!(
            "Checksum verification failed for {}",
            expected.name
        ));
    }
    Ok(())
}

fn digest_hex(hasher: Sha256) -> String {
    use std::fmt::Write;

    let mut output = String::with_capacity(64);
    for byte in hasher.finalize() {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn file_size_matches(path: &Path, expected_size: u64) -> bool {
    std::fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() == expected_size)
}

#[cfg(test)]
mod tests {
    use super::{
        byte_offset_to_utf16, ensure_model_token_budget, remove_stale_downloads,
        PrivacyFilterRuntime, MAX_MODEL_TOKENS,
    };

    async fn model_source_fixture(
        status: &str,
        body: &'static [u8],
    ) -> (String, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind source fixture");
        let url = format!(
            "http://{}/model",
            listener.local_addr().expect("source address")
        );
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let server = tokio::spawn(async move {
            let (mut stream, _) =
                tokio::time::timeout(std::time::Duration::from_secs(5), listener.accept())
                    .await
                    .expect("source should be requested")
                    .expect("accept source request");
            let mut request = [0u8; 4096];
            stream.read(&mut request).await.expect("read request");
            stream
                .write_all(response.as_bytes())
                .await
                .expect("write response");
            stream.write_all(body).await.expect("write model bytes");
        });
        (url, server)
    }

    #[tokio::test]
    async fn user_downloads_verified_model_bytes_from_the_mirror_when_the_primary_source_fails() {
        let (primary, primary_server) = model_source_fixture("503 Unavailable", b"").await;
        let (mirror, mirror_server) = model_source_fixture("200 OK", b"abc").await;
        let directory = tempfile::tempdir().expect("temporary download directory");
        let target = directory.path().join("model.bin");
        let (_cancel, mut cancellation) = tokio::sync::watch::channel(false);
        let file = super::ModelFile {
            name: "model.bin",
            size: 3,
            sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        };
        super::download_file(
            &reqwest::Client::new(),
            file,
            &[primary, mirror],
            &target,
            &mut cancellation,
            |_| {},
        )
        .await
        .expect("verified mirror download");
        assert_eq!(std::fs::read(target).expect("downloaded model"), b"abc");
        primary_server.await.expect("primary source finished");
        mirror_server.await.expect("mirror source finished");
    }

    #[tokio::test]
    async fn user_cannot_install_mirror_bytes_that_do_not_match_the_pinned_model_hash() {
        let (mirror, server) = model_source_fixture("200 OK", b"bad").await;
        let directory = tempfile::tempdir().expect("temporary download directory");
        let target = directory.path().join("model.bin");
        let (_cancel, mut cancellation) = tokio::sync::watch::channel(false);
        let file = super::ModelFile {
            name: "model.bin",
            size: 3,
            sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        };
        let error = super::download_file(
            &reqwest::Client::new(),
            file,
            &[mirror],
            &target,
            &mut cancellation,
            |_| {},
        )
        .await
        .expect_err("mismatched model must fail");
        assert!(error.contains("Checksum verification failed"));
        assert!(!target.exists());
        server.await.expect("mirror source finished");
    }

    #[tokio::test]
    async fn user_loses_a_connection_then_resumes_the_verified_model_without_duplicate_bytes() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/model", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            for attempt in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = [0u8; 2048];
                let count = stream.read(&mut request).await.unwrap();
                let request = String::from_utf8_lossy(&request[..count]).to_ascii_lowercase();
                if attempt == 0 {
                    assert!(request.contains("range: bytes=0-5"));
                    stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabc",
                        )
                        .await
                        .unwrap();
                } else {
                    assert!(request.contains("range: bytes=3-5"));
                    stream.write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Length: 3\r\nContent-Range: bytes 3-5/6\r\nConnection: close\r\n\r\ndef").await.unwrap();
                }
                stream.shutdown().await.unwrap();
            }
        });
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("model.bin");
        let (_sender, mut cancellation) = tokio::sync::watch::channel(false);
        let file = super::ModelFile {
            name: "model.bin",
            size: 6,
            sha256: "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721",
        };
        super::download_file(
            &reqwest::Client::new(),
            file,
            &[url],
            &target,
            &mut cancellation,
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(target).unwrap(), b"abcdef");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn user_cancels_a_download_then_no_other_source_is_contacted_or_partial_file_kept() {
        let directory = tempfile::tempdir().expect("temporary download directory");
        let target = directory.path().join("model.bin");
        let (_cancel, mut cancellation) = tokio::sync::watch::channel(true);
        let file = super::ModelFile {
            name: "model.bin",
            size: 3,
            sha256: "unused",
        };
        let error = super::download_file(
            &reqwest::Client::new(),
            file,
            &["http://127.0.0.1:1/model".into()],
            &target,
            &mut cancellation,
            |_| {},
        )
        .await
        .expect_err("cancelled download must stop");
        assert_eq!(error, "Privacy model download cancelled");
        assert!(!target.exists());
    }

    #[test]
    fn user_sees_download_progress_and_cancellation_when_a_local_model_is_downloading() {
        let runtime = PrivacyFilterRuntime::default();
        let cancellation = runtime
            .begin_download(super::models::PrivacyFilterModelId::AstrLinkGuard)
            .expect("first download should start");

        assert!(runtime
            .begin_download(super::models::PrivacyFilterModelId::OpenAi)
            .is_err());
        runtime
            .cancel_download(super::models::PrivacyFilterModelId::OpenAi)
            .unwrap();
        assert!(!*cancellation.borrow());
        runtime.update_progress(128, "tokenizer.json");
        assert_eq!(
            runtime
                .snapshot(super::models::PrivacyFilterModelId::AstrLinkGuard)
                .expect("download status should be available"),
            (true, 128, Some("tokenizer.json".to_string()))
        );

        runtime
            .cancel_download(super::models::PrivacyFilterModelId::AstrLinkGuard)
            .expect("download should be cancellable");
        assert!(*cancellation.borrow());
        runtime.finish_download();
        assert_eq!(
            runtime
                .snapshot(super::models::PrivacyFilterModelId::AstrLinkGuard)
                .expect("finished status should be available"),
            (false, 0, None)
        );
    }

    #[test]
    fn user_uses_an_isolated_app_data_directory_then_model_files_follow_that_directory() {
        use crate::core::system::paths::{app_directory_path, AppDirectory};
        let directory =
            super::model_directory(super::models::PrivacyFilterModelId::AstrLinkGuard).unwrap();
        let data = app_directory_path(AppDirectory::Data).unwrap();
        assert!(
            directory.starts_with(data),
            "model files must follow the same data root as other app data"
        );
    }

    #[test]
    fn user_gets_utf16_offsets_when_non_ascii_text_is_scanned() {
        let text = "张a😀";
        assert_eq!(byte_offset_to_utf16(text, 0), 0);
        assert_eq!(byte_offset_to_utf16(text, "张a".len()), 2);
        assert_eq!(byte_offset_to_utf16(text, text.len()), 4);
    }

    #[test]
    fn user_gets_a_local_privacy_scan_within_the_request_token_budget() {
        assert!(ensure_model_token_budget([MAX_MODEL_TOKENS - 1, 1]).is_ok());
    }

    #[test]
    fn user_scans_many_short_fragments_then_padding_does_not_consume_the_content_budget() {
        let mut encoding = tokenizers::Encoding::from_tokens(
            vec![tokenizers::Token::new(1, "sample".to_string(), (0, 6))],
            0,
        );
        encoding.pad(
            super::MAX_MODEL_WINDOW,
            0,
            0,
            "[PAD]",
            tokenizers::PaddingDirection::Right,
        );
        assert_eq!(super::unique_token_count(&encoding), 1);
        assert!(
            ensure_model_token_budget((0..33).map(|_| super::unique_token_count(&encoding)))
                .is_ok()
        );
    }

    #[test]
    fn user_does_not_get_a_partial_scan_when_the_request_exceeds_the_token_budget() {
        assert_eq!(
            ensure_model_token_budget([MAX_MODEL_TOKENS, 1]).unwrap_err(),
            "Privacy scan input exceeds the model token limit"
        );
    }

    #[tokio::test]
    async fn user_does_not_keep_interrupted_download_files_when_a_new_download_starts() {
        let directory = tempfile::tempdir().expect("temporary model directory should be created");
        let stale_download = directory
            .path()
            .join(format!("download-{}", uuid::Uuid::new_v4()));
        let unrelated_directory = directory.path().join("download-not-a-uuid");
        std::fs::create_dir(&stale_download).expect("stale download should be created");
        std::fs::create_dir(&unrelated_directory).expect("unrelated directory should be created");
        std::fs::write(stale_download.join("partial.onnx"), b"partial")
            .expect("partial download should be created");

        remove_stale_downloads(directory.path())
            .await
            .expect("stale downloads should be cleaned");

        assert!(!stale_download.exists());
        assert!(unrelated_directory.exists());
    }

    #[test]
    #[ignore = "requires the pinned model files in TOUCHAI_PRIVACY_MODEL_TEST_DIR"]
    fn user_gets_email_spans_when_the_verified_local_model_scans_private_contact_details() {
        let directory = std::env::var_os("TOUCHAI_PRIVACY_MODEL_TEST_DIR")
            .map(std::path::PathBuf::from)
            .expect("set TOUCHAI_PRIVACY_MODEL_TEST_DIR to the downloaded model fixture");
        let text = "My private email address is alice@example.com. Please contact me there.";

        let results = super::detect(vec![text.to_string(); 33], directory)
            .expect("the verified local model should load and scan text");

        assert_eq!(results.len(), 33);
        assert!(results[0].iter().any(|span| {
            span.kind == "email"
                && text.get(span.start..span.end) == Some("alice@example.com")
                && span.score.is_finite()
                && (0.0..=1.0).contains(&span.score)
        }));
    }
}
