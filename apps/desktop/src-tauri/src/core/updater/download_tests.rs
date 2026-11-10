use super::*;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    thread,
    time::Instant,
};

fn server(responses: Vec<&'static str>) -> (String, thread::JoinHandle<Vec<String>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let worker = thread::spawn(move || {
        let mut requests = Vec::new();
        for response in responses {
            let deadline = Instant::now() + Duration::from_secs(3);
            let mut stream = loop {
                if let Ok((stream, _)) = listener.accept() {
                    break stream;
                }
                assert!(Instant::now() < deadline, "update request did not arrive");
                thread::sleep(Duration::from_millis(5));
            };
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

fn asset() -> VelopackAsset {
    VelopackAsset {
        FileName: "TouchAI-1.2.3-windows-full.nupkg".to_string(),
        Size: 6,
        SHA256: Sha256::digest(b"abcdef")
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        ..Default::default()
    }
}

#[test]
fn user_resumes_an_interrupted_update_without_downloading_the_same_bytes_again() {
    let (base_url, worker) = server(vec![
        "HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabc",
        "HTTP/1.1 206 Partial Content\r\nContent-Length: 3\r\nContent-Range: bytes 3-5/6\r\nConnection: close\r\n\r\ndef",
    ]);
    let source = ProductHttpUpdateSource::new(&base_url, "touchai");
    let directory = tempfile::tempdir().unwrap();
    let partial = directory.path().join("update.partial");
    assert!(source
        .download_release_entry(&asset(), &partial, None)
        .is_err());
    assert_eq!(fs::read(&partial).unwrap(), b"abc");
    source
        .download_release_entry(&asset(), &partial, None)
        .unwrap();
    let requests = worker.join().unwrap();
    assert!(requests[1].contains("range: bytes=3-"));
    assert_eq!(fs::read(&partial).unwrap(), b"abcdef");
}

#[test]
fn user_gets_a_complete_package_when_the_server_ignores_the_resume_range() {
    let (base_url, worker) = server(vec![
        "HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabcdef",
    ]);
    let directory = tempfile::tempdir().unwrap();
    let partial = directory.path().join("update.partial");
    fs::write(&partial, b"abc").unwrap();
    ProductHttpUpdateSource::new(&base_url, "touchai")
        .download_release_entry(&asset(), &partial, None)
        .unwrap();
    worker.join().unwrap();
    assert_eq!(fs::read(&partial).unwrap(), b"abcdef");
}

#[test]
fn user_keeps_the_partial_package_intact_when_the_server_returns_the_wrong_range() {
    let (base_url, worker) = server(vec![
        "HTTP/1.1 206 Partial Content\r\nContent-Length: 3\r\nContent-Range: bytes 1-3/6\r\nConnection: close\r\n\r\nbcd",
    ]);
    let directory = tempfile::tempdir().unwrap();
    let partial = directory.path().join("update.partial");
    fs::write(&partial, b"abc").unwrap();
    let result = ProductHttpUpdateSource::new(&base_url, "touchai").download_release_entry(
        &asset(),
        &partial,
        None,
    );
    worker.join().unwrap();
    assert!(result.is_err());
    assert_eq!(fs::read(&partial).unwrap(), b"abc");
}

#[test]
fn user_recovers_from_a_corrupted_partial_with_one_verified_full_retry() {
    let (base_url, worker) = server(vec![
        "HTTP/1.1 206 Partial Content\r\nContent-Length: 3\r\nContent-Range: bytes 3-5/6\r\nConnection: close\r\n\r\ndef",
        "HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabcdef",
    ]);
    let directory = tempfile::tempdir().unwrap();
    let partial = directory.path().join("update.partial");
    fs::write(&partial, b"bad").unwrap();
    ProductHttpUpdateSource::new(&base_url, "touchai")
        .download_release_entry(&asset(), &partial, None)
        .unwrap();
    let requests = worker.join().unwrap();
    assert!(!requests[1].contains("range:"));
    assert_eq!(fs::read(&partial).unwrap(), b"abcdef");
}

#[test]
fn user_can_reuse_a_complete_verified_partial_without_network_access() {
    let directory = tempfile::tempdir().unwrap();
    let partial = directory.path().join("update.partial");
    fs::write(&partial, b"abcdef").unwrap();
    ProductHttpUpdateSource::new("http://127.0.0.1:1", "touchai")
        .download_release_entry(&asset(), &partial, None)
        .unwrap();
    assert_eq!(fs::read(&partial).unwrap(), b"abcdef");
}

#[test]
fn user_recovers_when_a_server_rejects_ranges() {
    let (base_url, worker) = server(vec![
        "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        "HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabcdef",
    ]);
    let directory = tempfile::tempdir().unwrap();
    let partial = directory.path().join("update.partial");
    fs::write(&partial, b"abc").unwrap();
    ProductHttpUpdateSource::new(&base_url, "touchai")
        .download_release_entry(&asset(), &partial, None)
        .unwrap();
    let requests = worker.join().unwrap();
    assert!(requests[0].contains("range: bytes=3-"));
    assert!(!requests[1].contains("range:"));
    assert_eq!(fs::read(&partial).unwrap(), b"abcdef");
}

#[test]
fn user_redownloads_a_complete_but_corrupted_partial_instead_of_installing_it() {
    let (base_url, worker) = server(vec![
        "HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabcdef",
    ]);
    let directory = tempfile::tempdir().unwrap();
    let partial = directory.path().join("update.partial");
    fs::write(&partial, b"badbad").unwrap();
    ProductHttpUpdateSource::new(&base_url, "touchai")
        .download_release_entry(&asset(), &partial, None)
        .unwrap();
    assert!(!worker.join().unwrap()[0].contains("range:"));
    assert_eq!(fs::read(&partial).unwrap(), b"abcdef");
}

#[test]
fn user_downloads_from_scratch_when_old_release_metadata_cannot_authenticate_a_partial() {
    let (base_url, worker) = server(vec![
        "HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabcdef",
    ]);
    let directory = tempfile::tempdir().unwrap();
    let partial = directory.path().join("update.partial");
    fs::write(&partial, b"abc").unwrap();
    let mut legacy = asset();
    legacy.SHA256.clear();
    ProductHttpUpdateSource::new(&base_url, "touchai")
        .download_release_entry(&legacy, &partial, None)
        .unwrap();
    assert!(!worker.join().unwrap()[0].contains("range:"));
    assert_eq!(fs::read(&partial).unwrap(), b"abcdef");
}

#[test]
fn user_keeps_retryable_partial_data_when_the_server_returns_invalid_headers_or_errors() {
    for response in [
        "HTTP/1.1 206 Partial Content\r\nContent-Length: 2\r\nContent-Range: bytes 3-5/6\r\nConnection: close\r\n\r\nde",
        "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n",
    ] {
        let (base_url, worker) = server(vec![response]);
        let directory = tempfile::tempdir().unwrap();
        let partial = directory.path().join("update.partial");
        fs::write(&partial, b"abc").unwrap();
        let result = ProductHttpUpdateSource::new(&base_url, "touchai")
            .download_release_entry(&asset(), &partial, None);
        worker.join().unwrap();
        assert!(result.is_err());
        assert_eq!(fs::read(&partial).unwrap(), b"abc");
    }
}

#[test]
fn user_cannot_download_more_than_the_declared_package_size() {
    let (base_url, worker) = server(vec![
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n7\r\nabcdefg\r\n0\r\n\r\n",
    ]);
    let directory = tempfile::tempdir().unwrap();
    let partial = directory.path().join("update.partial");
    let result = ProductHttpUpdateSource::new(&base_url, "touchai").download_release_entry(
        &asset(),
        &partial,
        None,
    );
    worker.join().unwrap();
    assert!(result.unwrap_err().to_string().contains("declared size"));
    assert!(fs::metadata(&partial).unwrap().len() <= asset().Size);
}

#[test]
fn user_sees_progress_for_the_resumed_bytes_and_a_complete_package() {
    let (base_url, worker) = server(vec![
        "HTTP/1.1 206 Partial Content\r\nContent-Length: 3\r\nContent-Range: bytes 3-5/6\r\nConnection: close\r\n\r\ndef",
    ]);
    let directory = tempfile::tempdir().unwrap();
    let partial = directory.path().join("update.partial");
    fs::write(&partial, b"abc").unwrap();
    let (sender, receiver) = mpsc::channel();
    ProductHttpUpdateSource::new(&base_url, "touchai")
        .download_release_entry(&asset(), &partial, Some(sender))
        .unwrap();
    worker.join().unwrap();
    assert_eq!(receiver.iter().collect::<Vec<_>>(), vec![50, 100]);
    assert_eq!(fs::read(&partial).unwrap(), b"abcdef");
}
