use reqwest::Url;
use std::{path::Path, sync::mpsc::Sender, time::Duration};
use velopack::{Error, VelopackAsset};

use crate::core::download::{download_to_path, DownloadRequest, DownloadTimeouts};

const UPDATE_DOWNLOAD_TIMEOUTS: DownloadTimeouts = DownloadTimeouts {
    connect: Duration::from_secs(15),
    operation: Duration::from_secs(60),
};

fn progress_percent(downloaded: u64, total: u64) -> i16 {
    if total == 0 {
        return 100;
    }
    (((downloaded.min(total) as f64 / total as f64) * 20.0).floor() as i16 * 5).clamp(0, 100)
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

    let mut url = Url::parse(&format!("{}/", base_url.trim_end_matches('/')))
        .map_err(|error| Error::Other(format!("Invalid update package base URL: {error}")))?;
    url.path_segments_mut()
        .map_err(|_| Error::Other("Invalid update package base URL".to_string()))?
        .pop_if_empty()
        .push(&asset.FileName);

    let expected_sha256 = (asset.SHA256.len() == 64
        && asset.SHA256.bytes().all(|byte| byte.is_ascii_hexdigit()))
    .then_some(asset.SHA256.as_str());

    let mut last_progress = -1_i16;
    let mut report = |downloaded: u64| {
        let Some(sender) = progress.as_ref() else {
            return;
        };
        let current = progress_percent(downloaded, asset.Size);
        if current != last_progress {
            let _ = sender.send(current);
            last_progress = current;
        }
    };

    download_to_path(
        &DownloadRequest {
            url: url.as_str(),
            destination: local_file,
            expected_size: asset.Size,
            expected_sha256,
            resume: true,
            timeouts: UPDATE_DOWNLOAD_TIMEOUTS,
        },
        Some(&mut report),
    )
    .map(|_| ())
    .map_err(|error| Error::Other(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::progress_percent;

    #[test]
    fn user_sees_whole_percentage_steps_without_exceeding_one_hundred() {
        assert_eq!(progress_percent(0, 6), 0);
        assert_eq!(progress_percent(3, 6), 50);
        assert_eq!(progress_percent(6, 6), 100);
        assert_eq!(progress_percent(7, 6), 100);
        assert_eq!(progress_percent(0, 0), 100);
    }
}
