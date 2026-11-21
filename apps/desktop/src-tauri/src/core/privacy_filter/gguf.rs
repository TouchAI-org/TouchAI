use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use super::models::PrivacyFilterModelId;
use super::{
    byte_offset_to_utf16, digest_hex, file_size_matches, inference_threads, verify_model_file,
    ModelFile, PrivacyFilterSpan,
};

pub(super) const RUNTIME_DIRECTORY: &str = "pf-runtime-v4";
pub(super) type ChildHandle = Arc<Mutex<Option<Child>>>;
const RUNTIME_ARCHIVE: &str = "runtime.zip";
// pf-v4 warms several document sizes before its handshake, including on CPU.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(300);
const SCAN_TIMEOUT: Duration = Duration::from_secs(180);

pub(super) struct RuntimeAsset {
    pub target: &'static str,
    pub file: ModelFile,
}

pub(super) fn runtime_asset() -> Option<RuntimeAsset> {
    let (target, size, sha256) = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => (
            "windows-amd64",
            23_626_234,
            "4457116e76d5861b28f26fa15613a943a434d35174f30aa3b8488e76bccc6545",
        ),
        ("macos", "x86_64") => (
            "darwin-amd64",
            1_494_412,
            "dc287579abeafe0be0add35305bde05f9cb06405f6b98dda5d71c9bf2c53c2a0",
        ),
        ("macos", "aarch64") => (
            "darwin-arm64",
            834_450,
            "da4c89248937221a880996964e76a3dec18a9f8f80f2ee39e1cf26ef0933ac69",
        ),
        ("linux", "x86_64") => (
            "linux-amd64",
            26_342_324,
            "8a7e61e6deebde68b13fc17009c84aef9da2230ea9e696c9e62b32e79c30db00",
        ),
        ("linux", "aarch64") => (
            "linux-arm64",
            1_183_381,
            "0c29b9fdd1452f75414ee5fc623cfec70f4180af5046a9e669a289db7bf3da08",
        ),
        _ => return None,
    };
    Some(RuntimeAsset {
        target,
        file: ModelFile {
            name: RUNTIME_ARCHIVE,
            size,
            sha256,
        },
    })
}

fn executable_name() -> &'static str {
    #[cfg(all(target_arch = "x86_64", not(target_os = "macos")))]
    if !(std::is_x86_feature_detected!("avx")
        && std::is_x86_feature_detected!("avx2")
        && std::is_x86_feature_detected!("fma")
        && std::is_x86_feature_detected!("bmi2"))
    {
        return if cfg!(windows) {
            "pf-serve-base.exe"
        } else {
            "pf-serve-base"
        };
    }
    if cfg!(windows) {
        "pf-serve.exe"
    } else {
        "pf-serve"
    }
}

pub(super) fn installed(directory: &Path) -> bool {
    runtime_asset().is_some_and(|asset| {
        file_size_matches(&directory.join(RUNTIME_ARCHIVE), asset.file.size)
            && directory.join(executable_name()).is_file()
    })
}

pub(super) fn unpack(directory: &Path) -> Result<(), String> {
    let asset = runtime_asset().ok_or("Privacy model runtime is unavailable on this platform")?;
    let archive = directory.join(RUNTIME_ARCHIVE);
    verify_model_file(&archive, asset.file)?;
    let mut zip = zip::ZipArchive::new(File::open(archive).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    if zip.len() > 100 {
        return Err("Privacy runtime archive has too many entries".into());
    }
    let mut total = 0u64;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|error| error.to_string())?;
        let relative = entry
            .enclosed_name()
            .ok_or("Invalid privacy runtime archive path")?;
        if relative == Path::new(RUNTIME_ARCHIVE)
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("Invalid privacy runtime archive entry".into());
        }
        total = total.saturating_add(entry.size());
        if total > 256 * 1024 * 1024 {
            return Err("Privacy runtime archive is too large".into());
        }
        let target = directory.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(target).map_err(|error| error.to_string())?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut output = File::options()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|error| error.to_string())?;
        std::io::copy(&mut entry, &mut output).map_err(|error| error.to_string())?;
        output.sync_all().map_err(|error| error.to_string())?;
        #[cfg(unix)]
        if target
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with("pf-serve"))
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755))
                .map_err(|error| error.to_string())?;
        }
    }
    if !installed(directory) {
        return Err("Privacy runtime executable is missing".into());
    }
    Ok(())
}

fn verified_executable(directory: &Path) -> Result<PathBuf, String> {
    let asset = runtime_asset().ok_or("Privacy model runtime is unavailable on this platform")?;
    let archive = directory.join(RUNTIME_ARCHIVE);
    verify_model_file(&archive, asset.file)?;
    let mut zip = zip::ZipArchive::new(File::open(archive).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|error| error.to_string())?;
        if entry.is_dir() {
            continue;
        }
        let relative = entry
            .enclosed_name()
            .ok_or("Invalid privacy runtime archive path")?;
        let target = directory.join(relative);
        if !file_size_matches(&target, entry.size()) {
            return Err("Privacy runtime file is incomplete".into());
        }
        let mut expected = Sha256::new();
        let mut actual = Sha256::new();
        let mut input = File::open(target).map_err(|error| error.to_string())?;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = entry.read(&mut buffer).map_err(|error| error.to_string())?;
            if count == 0 {
                break;
            }
            expected.update(&buffer[..count]);
        }
        loop {
            let count = input.read(&mut buffer).map_err(|error| error.to_string())?;
            if count == 0 {
                break;
            }
            actual.update(&buffer[..count]);
        }
        if digest_hex(expected) != digest_hex(actual) {
            return Err("Privacy runtime integrity verification failed".into());
        }
    }
    directory
        .join(executable_name())
        .canonicalize()
        .map_err(|error| error.to_string())
}

pub(super) struct GgufProcess {
    pub model_id: PrivacyFilterModelId,
    pub last_used: Instant,
    child: ChildHandle,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl GgufProcess {
    pub async fn load(
        model_id: PrivacyFilterModelId,
        directory: PathBuf,
        runtime_directory: PathBuf,
        child_handle: ChildHandle,
    ) -> Result<Self, String> {
        let checked_directory = directory.clone();
        let executable = tokio::task::spawn_blocking(move || {
            for file in model_id.spec().files {
                verify_model_file(&checked_directory.join(file.name), *file)?;
            }
            verified_executable(&runtime_directory)
        })
        .await
        .map_err(|_| "Privacy model verification failed".to_string())??;
        let mut command = Command::new(executable);
        command
            .arg(model_id.spec().files[0].name)
            .arg("0")
            .current_dir(directory)
            .env("PF_DEVICE", "cpu")
            .env("PF_NTHREADS", inference_threads().to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command
            .spawn()
            .map_err(|_| "Could not start the local privacy model".to_string())?;
        let input = child
            .stdin
            .take()
            .ok_or("Privacy model input is unavailable")?;
        let output = BufReader::new(
            child
                .stdout
                .take()
                .ok_or("Privacy model output is unavailable")?,
        );
        *child_handle
            .lock()
            .map_err(|_| "Privacy runtime process state is unavailable")? = Some(child);
        let mut process = Self {
            model_id,
            last_used: Instant::now(),
            child: child_handle,
            input,
            output,
        };
        tokio::time::timeout(STARTUP_TIMEOUT, process.read_hello())
            .await
            .map_err(|_| "Local privacy model startup timed out".to_string())??;
        Ok(process)
    }

    async fn read_hello(&mut self) -> Result<(), String> {
        let mut line = Vec::new();
        for _ in 0..4096 {
            let byte = self
                .output
                .read_u8()
                .await
                .map_err(|_| "Local privacy model could not load".to_string())?;
            if byte == b'\n' {
                let hello: serde_json::Value = serde_json::from_slice(&line)
                    .map_err(|_| "Invalid privacy runtime handshake".to_string())?;
                if hello.get("error").is_some()
                    || hello
                        .get("device")
                        .and_then(|value| value.as_str())
                        .is_none_or(str::is_empty)
                {
                    return Err("Local privacy model could not load".into());
                }
                return Ok(());
            }
            line.push(byte);
        }
        Err("Invalid privacy runtime handshake".into())
    }

    pub async fn detect(
        &mut self,
        texts: &[String],
    ) -> Result<Vec<Vec<PrivacyFilterSpan>>, String> {
        let result = tokio::time::timeout(SCAN_TIMEOUT, async {
            self.input
                .write_u32_le(texts.len() as u32)
                .await
                .map_err(protocol_error)?;
            for text in texts {
                self.input
                    .write_u32_le(text.len() as u32)
                    .await
                    .map_err(protocol_error)?;
                self.input
                    .write_all(text.as_bytes())
                    .await
                    .map_err(protocol_error)?;
            }
            self.input.flush().await.map_err(protocol_error)?;
            read_response(&mut self.output, texts).await
        })
        .await
        .map_err(|_| "Local privacy scan timed out".to_string())?;
        self.last_used = Instant::now();
        result
    }

    pub async fn stop(self) {
        let child = self.child.lock().ok().and_then(|mut child| child.take());
        if let Some(mut child) = child {
            let _ = child.kill().await;
        }
    }
}

impl Drop for GgufProcess {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut child) = child.take() {
                let _ = child.start_kill();
            }
        }
    }
}

fn protocol_error(_: std::io::Error) -> String {
    "Local privacy model communication failed".into()
}

async fn read_response(
    reader: &mut (impl AsyncRead + Unpin),
    texts: &[String],
) -> Result<Vec<Vec<PrivacyFilterSpan>>, String> {
    if reader.read_u32_le().await.map_err(protocol_error)? != 0 {
        return Err("Local privacy scan failed".into());
    }
    let mut results = Vec::with_capacity(texts.len());
    for text in texts {
        let count = reader.read_u32_le().await.map_err(protocol_error)? as usize;
        if count > text.len() || count > 16_384 {
            return Err("Invalid privacy model span count".into());
        }
        let mut spans = Vec::with_capacity(count);
        for _ in 0..count {
            let start = reader.read_i32_le().await.map_err(protocol_error)?;
            let end = reader.read_i32_le().await.map_err(protocol_error)?;
            let score = reader.read_f32_le().await.map_err(protocol_error)?;
            let label_length = reader.read_u8().await.map_err(protocol_error)? as usize;
            if start < 0
                || end <= start
                || end as usize > text.len()
                || !text.is_char_boundary(start as usize)
                || !text.is_char_boundary(end as usize)
                || !score.is_finite()
                || !(0.0..=1.0).contains(&score)
                || label_length == 0
                || label_length > 128
            {
                return Err("Invalid privacy model span".into());
            }
            let mut label = vec![0; label_length];
            reader
                .read_exact(&mut label)
                .await
                .map_err(protocol_error)?;
            let label = std::str::from_utf8(&label)
                .map_err(|_| "Invalid privacy model label".to_string())?;
            if let Some(kind) = normalized_kind(label) {
                spans.push(PrivacyFilterSpan {
                    start: byte_offset_to_utf16(text, start as usize),
                    end: byte_offset_to_utf16(text, end as usize),
                    kind: kind.into(),
                    score,
                });
            }
        }
        results.push(spans);
    }
    Ok(results)
}

fn normalized_kind(label: &str) -> Option<&'static str> {
    let normalized = label.to_ascii_lowercase();
    match normalized.strip_prefix("private_").unwrap_or(&normalized) {
        "common_secret" | "secret" | "password" => Some("common_secret"),
        "private_person" | "person" | "firstname" | "middlename" | "lastname" | "prefix" => {
            Some("private_person")
        }
        "private_address" | "address" | "street" | "buildingnumber" | "secondaryaddress"
        | "city" | "county" | "state" | "zipcode" | "gpscoordinates" | "ordinaldirection" => {
            Some("private_address")
        }
        "private_date" | "date" | "dateofbirth" | "time" => Some("private_date"),
        "email" => Some("email"),
        "phone" => Some("phone"),
        "url" => Some("url"),
        "account" | "account_number" | "username" | "accountname" | "bankaccount" | "iban"
        | "bic" | "ssn" | "bitcoinaddress" | "ethereumaddress" | "litecoinaddress" | "vin"
        | "vrm" | "imei" => Some("account"),
        "payment_card" | "creditcard" | "creditcardissuer" | "cvv" | "pin" | "maskednumber" => {
            Some("payment_card")
        }
        "ip_address" | "ipaddress" | "macaddress" => Some("ip_address"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    #[tokio::test]
    #[ignore = "requires verified GGUF files and pf-v4 runtime in TOUCHAI_PRIVACY_GGUF_TEST_DIR"]
    async fn user_selects_either_gguf_model_then_gets_valid_multilingual_spans_and_releases_the_process(
    ) {
        let directory = PathBuf::from(
            std::env::var_os("TOUCHAI_PRIVACY_GGUF_TEST_DIR").expect("fixture directory"),
        );
        let runtime = directory.join(format!(
            "pf-v4-{}",
            runtime_asset().expect("supported runtime").target
        ));
        let texts = vec![
            "Please email robin@example.net.".to_string(),
            "联系邮箱为 robin@example.net，请保密。".to_string(),
        ];
        for model in [PrivacyFilterModelId::OpenAi, PrivacyFilterModelId::OpenMed] {
            let child = ChildHandle::default();
            let mut process =
                GgufProcess::load(model, directory.clone(), runtime.clone(), child.clone())
                    .await
                    .expect("verified runtime starts");
            let results = process.detect(&texts).await.expect("model responds");
            assert_eq!(results.len(), texts.len());
            for (text, spans) in texts.iter().zip(results) {
                let units = text.encode_utf16().collect::<Vec<_>>();
                assert!(spans.iter().any(|span| span.kind == "email"
                    && String::from_utf16(&units[span.start..span.end]).unwrap()
                        == "robin@example.net"));
            }
            process.stop().await;
            assert!(child.lock().unwrap().is_none());
        }
    }

    #[tokio::test]
    async fn user_scans_multilingual_text_then_gets_utf16_spans_in_the_matching_privacy_category() {
        let text = "😀张三的邮箱 alice@example.com".to_string();
        let start = text.find("alice").unwrap();
        let mut response = Vec::new();
        response.extend_from_slice(&0u32.to_le_bytes());
        response.extend_from_slice(&1u32.to_le_bytes());
        response.extend_from_slice(&(start as i32).to_le_bytes());
        response.extend_from_slice(&(text.len() as i32).to_le_bytes());
        response.extend_from_slice(&0.97f32.to_le_bytes());
        response.push(5);
        response.extend_from_slice(b"EMAIL");
        let spans = read_response(&mut response.as_slice(), &[text.clone()])
            .await
            .unwrap();
        assert_eq!(spans[0][0].start, text[..start].encode_utf16().count());
        assert_eq!(spans[0][0].end, text.encode_utf16().count());
        assert_eq!(spans[0][0].kind, "email");
    }

    #[tokio::test]
    async fn user_receives_an_openai_account_number_then_the_account_span_is_preserved() {
        let text = "Account: AB12345678".to_string();
        let start = text.find("AB12345678").unwrap();
        let label = b"account_number";
        let mut response = Vec::new();
        response.extend_from_slice(&0u32.to_le_bytes());
        response.extend_from_slice(&1u32.to_le_bytes());
        response.extend_from_slice(&(start as i32).to_le_bytes());
        response.extend_from_slice(&(text.len() as i32).to_le_bytes());
        response.extend_from_slice(&0.97f32.to_le_bytes());
        response.push(label.len() as u8);
        response.extend_from_slice(label);

        let results = read_response(&mut response.as_slice(), &[text.clone()])
            .await
            .unwrap();

        assert_eq!(results[0].len(), 1);
        assert_eq!(results[0][0].kind, "account");
        assert_eq!(&text[results[0][0].start..results[0][0].end], "AB12345678");
    }

    #[tokio::test]
    async fn user_gets_a_failed_scan_when_the_runtime_returns_invalid_offsets_or_unbounded_output()
    {
        for (start, end, score) in [
            (-1i32, 3i32, 0.8f32),
            (1, 2, 0.8),
            (0, 8, 0.8),
            (0, 3, f32::NAN),
        ] {
            let mut response = Vec::new();
            response.extend_from_slice(&0u32.to_le_bytes());
            response.extend_from_slice(&1u32.to_le_bytes());
            response.extend_from_slice(&start.to_le_bytes());
            response.extend_from_slice(&end.to_le_bytes());
            response.extend_from_slice(&score.to_le_bytes());
            response.push(6);
            response.extend_from_slice(b"PERSON");
            assert!(read_response(&mut response.as_slice(), &["张三".into()])
                .await
                .is_err());
        }
        let response = [0u32.to_le_bytes(), u32::MAX.to_le_bytes()].concat();
        assert!(read_response(&mut response.as_slice(), &["safe".into()])
            .await
            .is_err());
    }

    #[tokio::test]
    async fn user_gets_a_generic_failure_when_the_local_runtime_returns_an_error_containing_input()
    {
        let (mut writer, mut reader) = tokio::io::duplex(128);
        writer.write_u32_le(1).await.unwrap();
        writer.write_u32_le(13).await.unwrap();
        writer.write_all(b"private value").await.unwrap();
        let error = read_response(&mut reader, &["private value".into()])
            .await
            .unwrap_err();
        assert!(!error.contains("private value"));
    }

    #[test]
    fn user_selects_multilingual_detection_then_matching_labels_follow_existing_category_controls()
    {
        assert_eq!(normalized_kind("private_email"), Some("email"));
        assert_eq!(normalized_kind("private_phone"), Some("phone"));
        assert_eq!(normalized_kind("FIRSTNAME"), Some("private_person"));
        assert_eq!(normalized_kind("PASSWORD"), Some("common_secret"));
        assert_eq!(normalized_kind("CREDITCARD"), Some("payment_card"));
        assert_eq!(normalized_kind("IPADDRESS"), Some("ip_address"));
        assert_eq!(normalized_kind("private_address"), Some("private_address"));
        assert_eq!(normalized_kind("CURRENCYCODE"), None);
    }
}
