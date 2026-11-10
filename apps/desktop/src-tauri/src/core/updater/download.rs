use reqwest::{blocking::Client, header, StatusCode, Url};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
    sync::mpsc::Sender,
    time::Duration,
};
use velopack::{Error, VelopackAsset};

fn matches_checksum(path: &Path, expected: &str) -> Result<bool, Error> {
    let mut file = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    let actual: String = hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(actual.eq_ignore_ascii_case(expected))
}

fn request_error(error: reqwest::Error) -> Error {
    Error::Other(format!("Update package request failed: {error}"))
}

pub(super) fn download_package(
    base_url: &str,
    asset: &VelopackAsset,
    local_file: &Path,
    progress: Option<Sender<i16>>,
) -> Result<(), Error> {
    if asset.Size == 0 {
        return Err(Error::Other(
            "Update package size must be positive".to_string(),
        ));
    }
    let can_resume =
        asset.SHA256.len() == 64 && asset.SHA256.bytes().all(|byte| byte.is_ascii_hexdigit());
    let mut offset = match fs::metadata(local_file) {
        Ok(metadata) if can_resume => metadata.len(),
        Ok(_) => 0,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => return Err(error.into()),
    };
    if offset == asset.Size && matches_checksum(local_file, &asset.SHA256)? {
        if let Some(sender) = progress {
            let _ = sender.send(100);
        }
        return Ok(());
    }
    if offset >= asset.Size {
        offset = 0;
    }

    let mut url = Url::parse(&format!("{}/", base_url.trim_end_matches('/')))?;
    url.path_segments_mut()
        .map_err(|_| Error::Other("Invalid update package base URL".to_string()))?
        .pop_if_empty()
        .push(&asset.FileName);
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(request_error)?;

    for attempt in 0..2 {
        let mut request = client
            .get(url.clone())
            .header(header::ACCEPT_ENCODING, "identity");
        if offset > 0 {
            request = request.header(header::RANGE, format!("bytes={offset}-"));
        }
        let response = request.send().map_err(request_error)?;
        if response.status() == StatusCode::RANGE_NOT_SATISFIABLE && offset > 0 && attempt == 0 {
            offset = 0;
            continue;
        }
        let mut response = response.error_for_status().map_err(request_error)?;
        if response.status() == StatusCode::PARTIAL_CONTENT {
            let expected_range = format!("bytes {offset}-{}/{}", asset.Size - 1, asset.Size);
            if response
                .headers()
                .get(header::CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                != Some(expected_range.as_str())
            {
                return Err(Error::Other(
                    "Update server returned an invalid Content-Range".to_string(),
                ));
            }
        } else if response.status() == StatusCode::OK {
            offset = 0;
        } else {
            return Err(Error::Other(format!(
                "Unexpected update response: {}",
                response.status()
            )));
        }
        if response
            .content_length()
            .is_some_and(|length| length != asset.Size - offset)
        {
            return Err(Error::Other(
                "Update server returned an invalid Content-Length".to_string(),
            ));
        }

        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .append(offset > 0)
            .truncate(offset == 0)
            .open(local_file)?;
        let mut downloaded = offset;
        let mut last_progress = -1;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let current_progress =
                ((downloaded as f64 / asset.Size as f64 * 20.0).floor() as i16) * 5;
            if current_progress != last_progress {
                if let Some(sender) = &progress {
                    let _ = sender.send(current_progress);
                }
                last_progress = current_progress;
            }
            let count = response.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            if count as u64 > asset.Size - downloaded {
                return Err(Error::Other(
                    "Update package exceeds its declared size".to_string(),
                ));
            }
            file.write_all(&buffer[..count])?;
            downloaded += count as u64;
        }
        drop(file);
        if downloaded != asset.Size {
            return Err(Error::SizeInvalid(
                local_file.to_path_buf(),
                asset.Size,
                downloaded,
            ));
        }
        if offset > 0 && !matches_checksum(local_file, &asset.SHA256)? {
            fs::remove_file(local_file)?;
            offset = 0;
            continue;
        }
        return Ok(());
    }
    Err(Error::Other(
        "Update package could not be resumed safely".to_string(),
    ))
}
