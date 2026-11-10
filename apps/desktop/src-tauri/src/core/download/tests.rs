use super::{download_bytes, download_to_path, DownloadError, DownloadRequest, DownloadTimeouts};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    thread,
    time::Duration,
};

const FONT_BYTES: &[u8] = b"verified font";

fn response(body: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn server(responses: Vec<String>) -> (String, thread::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let worker = thread::spawn(move || {
        let mut requests = Vec::new();
        for response in responses {
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            let mut stream = loop {
                if let Ok((stream, _)) = listener.accept() {
                    break stream;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "download request did not arrive"
                );
                thread::sleep(Duration::from_millis(5));
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0_u8];
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
                assert!(request.len() < 8192);
            }
            requests.push(String::from_utf8(request).unwrap().to_ascii_lowercase());
            stream.write_all(response.as_bytes()).unwrap();
        }
        requests
    });
    (format!("http://{address}"), worker)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[tokio::test]
async fn user_receives_a_complete_verified_asset_in_memory() {
    let (base_url, worker) = server(vec![response("verified font")]);

    let downloaded = download_bytes(
        &base_url,
        FONT_BYTES.len() as u64,
        &sha256_hex(FONT_BYTES),
        DownloadTimeouts::default(),
    )
    .await
    .expect("valid asset should download");

    worker.join().unwrap();
    assert_eq!(downloaded, FONT_BYTES);
}

#[tokio::test]
async fn user_is_not_given_an_asset_whose_digest_differs() {
    let (base_url, worker) = server(vec![response("mutated bytes")]);

    let error = download_bytes(
        &base_url,
        FONT_BYTES.len() as u64,
        &sha256_hex(FONT_BYTES),
        DownloadTimeouts::default(),
    )
    .await
    .expect_err("checksum mismatch must fail");

    worker.join().unwrap();
    assert!(matches!(error, DownloadError::ChecksumMismatch));
}

#[tokio::test]
async fn user_is_not_given_more_bytes_than_the_asset_declares() {
    let content = b"short";
    let (base_url, worker) = server(vec![
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\nA\r\n0123456789\r\n0\r\n\r\n".to_string(),
    ]);

    let error = download_bytes(
        &base_url,
        content.len() as u64,
        &sha256_hex(content),
        DownloadTimeouts::default(),
    )
    .await
    .expect_err("oversized response must fail");

    worker.join().unwrap();
    assert!(matches!(error, DownloadError::TooLarge { .. }));
}

#[tokio::test]
async fn user_is_not_given_a_truncated_asset() {
    let content = b"complete";
    let (base_url, worker) = server(vec![
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\ncomp\r\n0\r\n\r\n".to_string(),
    ]);

    let error = download_bytes(
        &base_url,
        content.len() as u64,
        &sha256_hex(content),
        DownloadTimeouts::default(),
    )
    .await
    .expect_err("short response must fail");

    worker.join().unwrap();
    assert!(matches!(error, DownloadError::SizeMismatch { .. }));
}

#[tokio::test]
async fn user_is_not_offered_a_resume_without_a_verifiable_digest() {
    let directory = tempfile::tempdir().unwrap();
    let destination = directory.path().join("asset.partial");
    fs::write(&destination, b"partial").unwrap();
    let url = "http://127.0.0.1:1/asset";

    let result = download_to_path(
        &DownloadRequest {
            url,
            destination: &destination,
            expected_size: 7,
            expected_sha256: Some("not-a-sha256"),
            resume: true,
            timeouts: DownloadTimeouts::default(),
        },
        None,
    );

    assert!(matches!(result, Err(DownloadError::InvalidRequest(_))));
    assert_eq!(fs::read(&destination).unwrap(), b"partial");
}

#[test]
fn user_is_told_why_a_transfer_cannot_start() {
    let directory = tempfile::tempdir().unwrap();
    let destination = directory.path().join("asset.partial");

    let error = download_to_path(
        &DownloadRequest {
            url: "http://127.0.0.1:1/asset",
            destination: &destination,
            expected_size: 0,
            expected_sha256: None,
            resume: true,
            timeouts: DownloadTimeouts::default(),
        },
        None,
    )
    .expect_err("zero-sized transfers must fail");

    assert!(matches!(error, DownloadError::InvalidRequest(_)));
    assert!(!destination.exists());
}
