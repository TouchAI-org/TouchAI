// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Verified HTTP downloads shared by update packages and bundled assets.
//!
//! `reqwest` owns HTTP and TLS. This module owns the transfer policy that
//! `reqwest` does not provide: resumable ranges, declared-size limits, and
//! whole-file SHA-256 verification.

use reqwest::{blocking::Client, header, StatusCode, Url};
use sha2::{Digest, Sha256};
use std::{
    fmt,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
    time::Duration,
};

const BUFFER_SIZE: usize = 64 * 1024;
const MAX_ATTEMPTS: usize = 2;

#[cfg(test)]
mod tests;

#[derive(Debug, Clone, Copy)]
pub struct DownloadTimeouts {
    pub connect: Duration,
    pub operation: Duration,
}

impl Default for DownloadTimeouts {
    fn default() -> Self {
        Self {
            connect: Duration::from_secs(15),
            operation: Duration::from_secs(60),
        }
    }
}

#[derive(Debug)]
pub enum DownloadError {
    InvalidUrl(String),
    InvalidRequest(String),
    Http(reqwest::Error),
    Io(std::io::Error),
    Status(StatusCode),
    InvalidRange(String),
    InvalidLength { expected: u64, actual: Option<u64> },
    TooLarge { expected: u64 },
    SizeMismatch { expected: u64, actual: u64 },
    ChecksumMismatch,
}

impl fmt::Display for DownloadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidUrl(error) => write!(formatter, "invalid download URL: {error}"),
            Self::InvalidRequest(error) => write!(formatter, "{error}"),
            Self::Http(error) => write!(formatter, "download request failed: {error}"),
            Self::Io(error) => write!(formatter, "download file operation failed: {error}"),
            Self::Status(status) => write!(formatter, "unexpected download response: {status}"),
            Self::InvalidRange(value) => write!(formatter, "invalid Content-Range: {value}"),
            Self::InvalidLength { expected, actual } => write!(
                formatter,
                "invalid Content-Length: expected {expected}, got {}",
                actual.map_or_else(|| "unknown".to_string(), |value| value.to_string())
            ),
            Self::TooLarge { expected } => {
                write!(
                    formatter,
                    "download exceeds its declared size of {expected} bytes"
                )
            }
            Self::SizeMismatch { expected, actual } => {
                write!(
                    formatter,
                    "download size mismatch: expected {expected}, got {actual}"
                )
            }
            Self::ChecksumMismatch => write!(formatter, "download checksum mismatch"),
        }
    }
}

impl std::error::Error for DownloadError {}

impl From<reqwest::Error> for DownloadError {
    fn from(error: reqwest::Error) -> Self {
        Self::Http(error)
    }
}

impl From<std::io::Error> for DownloadError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DownloadOutcome {
    pub downloaded: u64,
    pub resumed_from: u64,
}

pub struct DownloadRequest<'a> {
    pub url: &'a str,
    pub destination: &'a Path,
    pub expected_size: u64,
    pub expected_sha256: Option<&'a str>,
    pub resume: bool,
    pub timeouts: DownloadTimeouts,
}

/// Download `url` to `destination`, optionally resuming a partial file.
///
/// A partial file is only reused when `expected_sha256` is present, because
/// otherwise the existing bytes cannot be authenticated.
pub fn download_to_path(
    request: &DownloadRequest<'_>,
    mut progress: Option<&mut dyn FnMut(u64)>,
) -> Result<DownloadOutcome, DownloadError> {
    let expected_sha256 = validate_expected(request.expected_size, request.expected_sha256)?;
    let can_resume = request.resume && expected_sha256.is_some();
    let mut offset = match fs::metadata(request.destination) {
        Ok(metadata) if can_resume => metadata.len(),
        Ok(_) => 0,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => return Err(error.into()),
    };

    if let Some(expected_sha256) = expected_sha256 {
        if offset == request.expected_size {
            if matches_checksum(request.destination, expected_sha256)? {
                report_progress(&mut progress, request.expected_size);
                return Ok(DownloadOutcome {
                    downloaded: request.expected_size,
                    resumed_from: offset,
                });
            }
            offset = 0;
        } else if offset > request.expected_size {
            offset = 0;
        }
    }

    let url =
        Url::parse(request.url).map_err(|error| DownloadError::InvalidUrl(error.to_string()))?;
    let client = Client::builder()
        .connect_timeout(request.timeouts.connect)
        .timeout(request.timeouts.operation)
        .build()?;

    for attempt in 0..MAX_ATTEMPTS {
        let mut pending = client
            .get(url.clone())
            .header(header::ACCEPT_ENCODING, "identity");
        if offset > 0 {
            pending = pending.header(header::RANGE, format!("bytes={offset}-"));
        }

        let response = pending.send()?;
        if response.status() == StatusCode::RANGE_NOT_SATISFIABLE && offset > 0 && attempt == 0 {
            offset = 0;
            continue;
        }

        let mut response = response.error_for_status()?;
        if response.status() == StatusCode::PARTIAL_CONTENT {
            let expected_range = format!(
                "bytes {offset}-{}/{}",
                request.expected_size - 1,
                request.expected_size
            );
            if response
                .headers()
                .get(header::CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                != Some(expected_range.as_str())
            {
                return Err(DownloadError::InvalidRange(
                    response
                        .headers()
                        .get(header::CONTENT_RANGE)
                        .and_then(|value| value.to_str().ok())
                        .unwrap_or("missing")
                        .to_string(),
                ));
            }
        } else if response.status() == StatusCode::OK {
            offset = 0;
        } else {
            return Err(DownloadError::Status(response.status()));
        }

        if let Some(length) = response.content_length() {
            let expected = request.expected_size - offset;
            if length != expected {
                return Err(DownloadError::InvalidLength {
                    expected,
                    actual: Some(length),
                });
            }
        }

        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .append(offset > 0)
            .truncate(offset == 0)
            .open(request.destination)?;
        let mut downloaded = offset;
        let mut buffer = [0_u8; BUFFER_SIZE];
        report_progress(&mut progress, downloaded);
        loop {
            let count = response.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            if count as u64 > request.expected_size - downloaded {
                return Err(DownloadError::TooLarge {
                    expected: request.expected_size,
                });
            }
            file.write_all(&buffer[..count])?;
            downloaded += count as u64;
            report_progress(&mut progress, downloaded);
        }
        drop(file);

        if downloaded != request.expected_size {
            return Err(DownloadError::SizeMismatch {
                expected: request.expected_size,
                actual: downloaded,
            });
        }

        if let Some(expected_sha256) = expected_sha256 {
            if !matches_checksum(request.destination, expected_sha256)? {
                if offset > 0 {
                    fs::remove_file(request.destination)?;
                    offset = 0;
                    continue;
                }
                return Err(DownloadError::ChecksumMismatch);
            }
        }

        return Ok(DownloadOutcome {
            downloaded,
            resumed_from: offset,
        });
    }

    Err(DownloadError::InvalidRequest(
        "download could not be resumed safely".to_string(),
    ))
}

/// Download a small asset into memory after validating its size and SHA-256.
pub async fn download_bytes(
    url: &str,
    expected_size: u64,
    expected_sha256: &str,
    timeouts: DownloadTimeouts,
) -> Result<Vec<u8>, DownloadError> {
    let expected_sha256 = validate_expected(expected_size, Some(expected_sha256))?
        .ok_or_else(|| DownloadError::InvalidRequest("SHA-256 is required".to_string()))?;
    let client = reqwest::Client::builder()
        .connect_timeout(timeouts.connect)
        .timeout(timeouts.operation)
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .build()?;
    let mut response = client
        .get(url)
        .header(header::ACCEPT_ENCODING, "identity")
        .send()
        .await?
        .error_for_status()?;
    if let Some(length) = response.content_length() {
        if length != expected_size {
            return Err(DownloadError::InvalidLength {
                expected: expected_size,
                actual: Some(length),
            });
        }
    }

    let mut data = Vec::with_capacity(expected_size.min(8 * 1024 * 1024) as usize);
    let mut downloaded = 0_u64;
    loop {
        let Some(chunk) = response.chunk().await? else {
            break;
        };
        if chunk.is_empty() {
            continue;
        }
        if chunk.len() as u64 > expected_size - downloaded {
            return Err(DownloadError::TooLarge {
                expected: expected_size,
            });
        }
        data.extend_from_slice(&chunk);
        downloaded += chunk.len() as u64;
    }
    if downloaded != expected_size {
        return Err(DownloadError::SizeMismatch {
            expected: expected_size,
            actual: downloaded,
        });
    }
    if !sha256_hex(&data).eq_ignore_ascii_case(expected_sha256) {
        return Err(DownloadError::ChecksumMismatch);
    }
    Ok(data)
}

fn validate_expected<'a>(
    expected_size: u64,
    expected_sha256: Option<&'a str>,
) -> Result<Option<&'a str>, DownloadError> {
    if expected_size == 0 {
        return Err(DownloadError::InvalidRequest(
            "download size must be positive".to_string(),
        ));
    }
    expected_sha256
        .map(|value| {
            valid_sha256(value).ok_or_else(|| {
                DownloadError::InvalidRequest(
                    "expected_sha256 must be 64 hexadecimal characters".to_string(),
                )
            })
        })
        .transpose()
}

fn valid_sha256(value: &str) -> Option<&str> {
    (value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())).then_some(value)
}

fn matches_checksum(path: &Path, expected: &str) -> Result<bool, DownloadError> {
    Ok(file_sha256(path)?.eq_ignore_ascii_case(expected))
}

fn file_sha256(path: &Path) -> Result<String, DownloadError> {
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; BUFFER_SIZE];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(hash_hex(hash.finalize()))
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    hash_hex(Sha256::digest(bytes))
}

fn hash_hex(digest: impl AsRef<[u8]>) -> String {
    let mut output = String::with_capacity(digest.as_ref().len() * 2);
    for byte in digest.as_ref() {
        use std::fmt::Write as _;
        let _ = write!(&mut output, "{byte:02x}");
    }
    output
}

fn report_progress(progress: &mut Option<&mut dyn FnMut(u64)>, downloaded: u64) {
    if let Some(callback) = progress.as_mut() {
        (**callback)(downloaded);
    }
}
