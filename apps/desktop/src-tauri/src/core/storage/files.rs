//! Native publication and physical identity for app-owned files.

use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
};

use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct FileIdentity {
    pub volume: u64,
    pub id: [u8; 16],
}

#[derive(Clone, Debug)]
pub(crate) struct PhysicalFile {
    pub identity: Option<FileIdentity>,
    pub allocated: u64,
    pub links: u64,
}

pub(crate) fn is_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return metadata.file_attributes() & 0x400 != 0;
    }
    #[cfg(not(windows))]
    false
}

pub(crate) fn validate_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("storage_invalid_path".into());
    }
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if is_reparse(&metadata) => return Err("storage_invalid_path".into()),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err("storage_io_failed".into()),
        }
    }
    Ok(())
}

/// Resolve redirects in a trusted platform path's ancestors, never in its own leaf.
/// Descendants are still checked by validate_path/open_owned/remove_owned.
pub(crate) fn resolve_platform_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("storage_invalid_path".into());
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if is_reparse(&metadata) => return Err("storage_invalid_path".into()),
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err("storage_io_failed".into()),
    }
    let leaf = path.file_name().ok_or("storage_invalid_path")?;
    let mut parent = path.parent().ok_or("storage_invalid_path")?;
    let mut missing = Vec::new();
    let mut resolved = loop {
        match fs::canonicalize(parent) {
            Ok(resolved) => break resolved,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if fs::symlink_metadata(parent).is_ok() {
                    return Err("storage_invalid_path".into());
                }
                missing.push(
                    parent
                        .file_name()
                        .ok_or("storage_invalid_path")?
                        .to_os_string(),
                );
                parent = parent.parent().ok_or("storage_invalid_path")?;
            }
            Err(_) => return Err("storage_io_failed".into()),
        }
    };
    if !fs::metadata(&resolved)
        .map_err(|_| "storage_io_failed")?
        .is_dir()
    {
        return Err("storage_invalid_path".into());
    }
    for name in missing.into_iter().rev() {
        resolved.push(name);
    }
    resolved.push(leaf);
    validate_path(&resolved)?;
    Ok(resolved)
}

pub(crate) fn is_hash(value: &str, length: usize) -> bool {
    value.len() == length && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(crate) struct PinnedInput {
    file: File,
    _parents: Vec<File>,
}

impl Read for PinnedInput {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.file.read(bytes)
    }
}

/// Bind a managed read to directory/file handles; metadata checks alone have a redirect race.
pub(crate) fn open_owned(root: &Path, path: &Path) -> Result<PinnedInput, String> {
    validate_path(path)?;
    if !path.starts_with(root) || path == root {
        return Err("storage_invalid_path".into());
    }
    #[cfg(unix)]
    {
        use std::{
            ffi::CString,
            os::{
                fd::{AsRawFd, FromRawFd},
                unix::{ffi::OsStrExt, fs::OpenOptionsExt},
            },
        };
        let mut directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open("/")
            .map_err(|_| "storage_io_failed")?;
        for component in path.parent().ok_or("storage_invalid_path")?.components() {
            if let Component::Normal(name) = component {
                let name = CString::new(name.as_bytes()).map_err(|_| "storage_invalid_path")?;
                let fd = unsafe {
                    libc::openat(
                        directory.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if fd < 0 {
                    return Err("storage_invalid_path".into());
                }
                directory = unsafe { File::from_raw_fd(fd) };
            }
        }
        let leaf = CString::new(path.file_name().ok_or("storage_invalid_path")?.as_bytes())
            .map_err(|_| "storage_invalid_path")?;
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                leaf.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err("storage_io_failed".into());
        }
        let file = unsafe { File::from_raw_fd(fd) };
        if !file.metadata().map_err(|_| "storage_io_failed")?.is_file() {
            return Err("storage_invalid_path".into());
        }
        return Ok(PinnedInput {
            file,
            _parents: vec![directory],
        });
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
            FILE_SHARE_WRITE,
        };
        let mut parents = Vec::new();
        for parent in path
            .parent()
            .ok_or("storage_invalid_path")?
            .ancestors()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
        {
            let handle = OpenOptions::new()
                .read(true)
                .share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE).0)
                .custom_flags((FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT).0)
                .open(parent)
                .map_err(|_| "storage_invalid_path")?;
            if is_reparse(&handle.metadata().map_err(|_| "storage_invalid_path")?) {
                return Err("storage_invalid_path".into());
            }
            parents.push(handle);
        }
        let file = OpenOptions::new()
            .read(true)
            .share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE).0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
            .open(path)
            .map_err(|_| "storage_io_failed")?;
        let metadata = file.metadata().map_err(|_| "storage_io_failed")?;
        if is_reparse(&metadata) || !metadata.is_file() {
            return Err("storage_invalid_path".into());
        }
        return Ok(PinnedInput {
            file,
            _parents: parents,
        });
    }
    #[cfg(not(any(unix, windows)))]
    Err("storage_io_failed".into())
}

pub(crate) fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|_| "storage_io_failed")?;
    hash_reader(&mut file).map_err(|_| "storage_io_failed".into())
}

fn hash_reader(reader: &mut impl Read) -> io::Result<String> {
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex_digest(&hasher.finalize()))
}

fn hex_digest(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(&mut output, "{byte:02x}");
    }
    output
}

pub(crate) fn physical_file(path: &Path) -> Result<PhysicalFile, String> {
    validate_path(path)?;
    let file = File::open(path).map_err(|_| "storage_io_failed")?;
    physical_handle(&file)
}

#[cfg(unix)]
pub(crate) fn physical_handle(file: &File) -> Result<PhysicalFile, String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata().map_err(|_| "storage_io_failed")?;
    let mut id = [0_u8; 16];
    id[..8].copy_from_slice(&metadata.ino().to_le_bytes());
    Ok(PhysicalFile {
        identity: Some(FileIdentity {
            volume: metadata.dev(),
            id,
        }),
        allocated: metadata.blocks().saturating_mul(512),
        links: metadata.nlink(),
    })
}

#[cfg(windows)]
pub(crate) fn physical_handle(file: &File) -> Result<PhysicalFile, String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{
            FileCompressionInfo, FileIdInfo, FileStandardInfo, GetFileInformationByHandleEx,
            FILE_ATTRIBUTE_COMPRESSED, FILE_ATTRIBUTE_SPARSE_FILE, FILE_COMPRESSION_INFO,
            FILE_ID_INFO, FILE_STANDARD_INFO,
        },
    };
    let mut id = FILE_ID_INFO::default();
    let mut standard = FILE_STANDARD_INFO::default();
    // Both structures are filled from the already-opened file, including ReFS's full ID.
    unsafe {
        GetFileInformationByHandleEx(
            HANDLE(file.as_raw_handle()),
            FileStandardInfo,
            (&mut standard as *mut FILE_STANDARD_INFO).cast(),
            std::mem::size_of::<FILE_STANDARD_INFO>() as u32,
        )
        .map_err(|_| "storage_io_failed")?;
    }
    let identity = unsafe {
        GetFileInformationByHandleEx(
            HANDLE(file.as_raw_handle()),
            FileIdInfo,
            (&mut id as *mut FILE_ID_INFO).cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    }
    .ok()
    .and_then(|_| {
        (id.FileId.Identifier != [0; 16]).then_some(FileIdentity {
            volume: id.VolumeSerialNumber,
            id: id.FileId.Identifier,
        })
    });
    use std::os::windows::fs::MetadataExt;
    let attributes = file
        .metadata()
        .map_err(|_| "storage_io_failed")?
        .file_attributes();
    let mut allocated = standard.AllocationSize.max(0) as u64;
    if attributes & (FILE_ATTRIBUTE_COMPRESSED | FILE_ATTRIBUTE_SPARSE_FILE).0 != 0 {
        let mut compression = FILE_COMPRESSION_INFO::default();
        unsafe {
            GetFileInformationByHandleEx(
                HANDLE(file.as_raw_handle()),
                FileCompressionInfo,
                (&mut compression as *mut FILE_COMPRESSION_INFO).cast(),
                std::mem::size_of::<FILE_COMPRESSION_INFO>() as u32,
            )
        }
        .map_err(|_| "storage_io_failed")?;
        allocated = compression.CompressedFileSize.max(0) as u64;
    }
    Ok(PhysicalFile {
        identity,
        allocated,
        links: standard.NumberOfLinks as u64,
    })
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn physical_handle(file: &File) -> Result<PhysicalFile, String> {
    Ok(PhysicalFile {
        identity: None,
        allocated: file.metadata().map_err(|_| "storage_io_failed")?.len(),
        links: 0,
    })
}

pub(crate) fn refuse_same_file(source: &Path, destination: &Path) -> Result<(), String> {
    validate_path(destination)?;
    if source == destination {
        return Err("storage_invalid_path".into());
    }
    if destination.exists() {
        let source_id = physical_file(source)?.identity;
        let destination_id = physical_file(destination)?.identity;
        if source_id.is_none() || source_id == destination_id {
            return Err("storage_invalid_path".into());
        }
    }
    Ok(())
}

pub(crate) fn available_space(path: &Path) -> Result<u64, String> {
    validate_path(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::{core::PCWSTR, Win32::Storage::FileSystem::GetDiskFreeSpaceExW};
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut available = 0;
        unsafe { GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut available), None, None) }
            .map_err(|_| "storage_io_failed")?;
        return Ok(available);
    }
    #[cfg(unix)]
    {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let name = CString::new(path.as_os_str().as_bytes()).map_err(|_| "storage_invalid_path")?;
        let mut value = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        if unsafe { libc::statvfs(name.as_ptr(), value.as_mut_ptr()) } != 0 {
            return Err("storage_io_failed".into());
        }
        let value = unsafe { value.assume_init() };
        return Ok((value.f_bavail as u64).saturating_mul(value.f_frsize as u64));
    }
    #[cfg(not(any(unix, windows)))]
    Err("storage_io_failed".into())
}

/// No reparse point is traversed. An incomplete walk must never become a deletion plan.
pub(crate) fn walk(root: &Path, limit: usize) -> Result<Vec<PathBuf>, String> {
    walk_entries(root, limit, false)
}

pub(crate) fn walk_entries(
    root: &Path,
    limit: usize,
    include_directories: bool,
) -> Result<Vec<PathBuf>, String> {
    validate_path(root)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut stack = vec![(root.to_path_buf(), 0_usize)];
    let mut files = Vec::new();
    let mut visited = 0_usize;
    while let Some((path, depth)) = stack.pop() {
        visited += 1;
        if visited > limit || depth > 64 {
            return Err("storage_scan_incomplete".into());
        }
        let metadata = fs::symlink_metadata(&path).map_err(|_| "storage_scan_incomplete")?;
        if is_reparse(&metadata) {
            return Err("storage_invalid_path".into());
        }
        if metadata.is_file() {
            files.push(path);
        } else if metadata.is_dir() {
            if include_directories {
                files.push(path.clone());
            }
            for entry in fs::read_dir(&path).map_err(|_| "storage_scan_incomplete")? {
                let entry = entry.map_err(|_| "storage_scan_incomplete")?;
                stack.push((entry.path(), depth + 1));
            }
        }
    }
    Ok(files)
}

pub(crate) fn unique_allocated(paths: &[PathBuf]) -> Result<u64, String> {
    let mut identities = HashSet::new();
    let mut total = 0_u64;
    for path in paths {
        let file = physical_file(path)?;
        if file
            .identity
            .as_ref()
            .is_none_or(|id| identities.insert(id.clone()))
        {
            total = total.saturating_add(file.allocated);
        }
    }
    Ok(total)
}

fn database_paths(path: &Path) -> [PathBuf; 3] {
    let mut wal = path.file_name().unwrap_or_default().to_os_string();
    let mut shm = wal.clone();
    wal.push("-wal");
    shm.push("-shm");
    [
        path.to_path_buf(),
        path.with_file_name(wal),
        path.with_file_name(shm),
    ]
}

pub(crate) fn database_allocated(path: &Path) -> Result<u64, String> {
    let mut existing = Vec::new();
    for path in database_paths(path) {
        match fs::symlink_metadata(&path) {
            Ok(_) => existing.push(path),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err("storage_io_failed".into()),
        }
    }
    unique_allocated(&existing)
}

pub(crate) fn attachment_path(cache: &Path, kind: &str, hash: &str) -> Result<PathBuf, String> {
    if !matches!(kind, "image" | "file") || !is_hash(hash, 64) {
        return Err("storage_invalid_path".into());
    }
    Ok(cache
        .join("attachments")
        .join(if kind == "image" { "images" } else { "files" })
        .join(&hash[..3])
        .join(hash))
}

/// The external source is always snapshotted before content is published.
pub(crate) fn publish_attachment(
    cache: &Path,
    kind: &str,
    source: &Path,
    expected_hash: Option<&str>,
) -> Result<(String, PathBuf, u64), String> {
    if !matches!(kind, "image" | "file") {
        return Err("storage_invalid_path".into());
    }
    let cache = resolve_platform_path(cache)?;
    let cache = cache.as_path();
    let source = source.canonicalize().map_err(|_| "storage_invalid_path")?;
    let mut input = File::open(&source).map_err(|_| "storage_io_failed")?;
    if !input.metadata().map_err(|_| "storage_io_failed")?.is_file() {
        return Err("storage_invalid_path".into());
    }
    let captured_hash = hash_reader(&mut input).map_err(|_| "storage_io_failed")?;
    if expected_hash.is_some_and(|expected| expected != captured_hash) {
        return Err("storage_corrupt_attachment".into());
    }
    let existing_target = attachment_path(cache, kind, &captured_hash)?;
    validate_path(&existing_target)?;
    if existing_target.exists() {
        if sha256_file(&existing_target)? != captured_hash {
            return Err("storage_corrupt_attachment".into());
        }
        mark_existing_immutable(&existing_target)?;
        let size = fs::metadata(&existing_target)
            .map_err(|_| "storage_io_failed")?
            .len();
        return Ok((captured_hash, existing_target, size));
    }
    use std::io::{Seek, SeekFrom};
    input
        .seek(SeekFrom::Start(0))
        .map_err(|_| "storage_io_failed")?;
    let staging = cache.join("attachments").join(".staging");
    validate_path(&staging)?;
    fs::create_dir_all(&staging).map_err(|_| "storage_io_failed")?;
    let canonical_staging = staging.canonicalize().map_err(|_| "storage_invalid_path")?;
    if source.starts_with(&canonical_staging) && physical_handle(&input)?.links == 1 {
        if let Some(expected) = expected_hash.filter(|hash| is_hash(hash, 64)) {
            if hash_reader(&mut input).map_err(|_| "storage_io_failed")? != expected {
                return Err("storage_corrupt_attachment".into());
            }
            let target = attachment_path(cache, kind, expected)?;
            validate_path(&target)?;
            fs::create_dir_all(target.parent().ok_or("storage_invalid_path")?)
                .map_err(|_| "storage_io_failed")?;
            let published = if target.exists() {
                true
            } else {
                mark_immutable(&source)?;
                match fs::hard_link(&source, &target) {
                    Ok(()) => true,
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => true,
                    Err(error) if link_unavailable(&error) => false,
                    Err(_) => return Err("storage_io_failed".into()),
                }
            };
            if published {
                if sha256_file(&target)? != expected {
                    return Err("storage_corrupt_attachment".into());
                }
                mark_existing_immutable(&target)?;
                return Ok((
                    expected.to_string(),
                    target,
                    input.metadata().map_err(|_| "storage_io_failed")?.len(),
                ));
            }
            use std::io::{Seek, SeekFrom};
            input
                .seek(SeekFrom::Start(0))
                .map_err(|_| "storage_io_failed")?;
        }
    }
    validate_path(&staging)?;
    fs::create_dir_all(&staging).map_err(|_| "storage_io_failed")?;
    let mut output = tempfile::Builder::new()
        .prefix("attachment-")
        .tempfile_in(&staging)
        .map_err(|_| "storage_io_failed")?;
    let mut hash = Sha256::new();
    let mut size = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = input.read(&mut buffer).map_err(|_| "storage_io_failed")?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
        output
            .write_all(&buffer[..read])
            .map_err(|_| "storage_io_failed")?;
        size = size.checked_add(read as u64).ok_or("storage_io_failed")?;
    }
    let hash = hex_digest(&hash.finalize());
    if hash != captured_hash || expected_hash.is_some_and(|expected| expected != hash) {
        return Err("storage_corrupt_attachment".into());
    }
    let target = attachment_path(cache, kind, &hash)?;
    validate_path(&target)?;
    fs::create_dir_all(target.parent().ok_or("storage_invalid_path")?)
        .map_err(|_| "storage_io_failed")?;
    if target.exists() {
        if sha256_file(&target)? != hash {
            return Err("storage_corrupt_attachment".into());
        }
        mark_existing_immutable(&target)?;
        return Ok((hash, target, size));
    }
    output
        .as_file()
        .sync_all()
        .map_err(|_| "storage_io_failed")?;
    // These are two app-owned immutable hash paths, never a user file or editable output.
    let peer = attachment_path(cache, if kind == "image" { "file" } else { "image" }, &hash)?;
    let linked = if peer.exists() && sha256_file(&peer)? == hash {
        mark_existing_immutable(&peer)?;
        match fs::hard_link(&peer, &target) {
            Ok(()) => true,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => true,
            Err(error) if link_unavailable(&error) => false,
            Err(_) => return Err("storage_io_failed".into()),
        }
    } else {
        false
    };
    if !linked {
        match output.persist_noclobber(&target) {
            Ok(_) => {}
            Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err("storage_io_failed".into()),
        }
    }
    if sha256_file(&target)? != hash {
        return Err("storage_corrupt_attachment".into());
    }
    mark_immutable(&target)?;
    Ok((hash, target, size))
}

fn mark_existing_immutable(path: &Path) -> Result<(), String> {
    let permissions = fs::metadata(path)
        .map_err(|_| "storage_io_failed")?
        .permissions();
    if physical_file(path)?.links > 1 {
        if !permissions.readonly() {
            return Err("storage_corrupt_attachment".into());
        }
        return Ok(());
    }
    mark_immutable(path)
}

/// Retain an immutable clipboard/screenshot name without retaining another copy.
pub(crate) fn reuse_managed_alias(
    cache: &Path,
    source: &Path,
    target: &Path,
) -> Result<bool, String> {
    let physical_cache = resolve_platform_path(cache)?;
    let source = if let Ok(relative) = source.strip_prefix(cache) {
        physical_cache.join(relative)
    } else {
        source.to_path_buf()
    };
    if ![
        physical_cache.join("clipboard"),
        physical_cache.join("temporary"),
    ]
    .iter()
    .any(|root| source.starts_with(root))
    {
        return Ok(false);
    }
    validate_path(&source)?;
    validate_path(target)?;
    let source = source.canonicalize().map_err(|_| "storage_io_failed")?;
    let trusted = [
        physical_cache.join("clipboard"),
        physical_cache.join("temporary"),
    ]
    .iter()
    .filter_map(|root| root.canonicalize().ok())
    .any(|root| source.starts_with(root));
    if !trusted {
        return Ok(false);
    }
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let clipboard = name.rsplit_once('.').is_some_and(|(stem, extension)| {
        !stem.is_empty()
            && stem.bytes().all(|byte| byte.is_ascii_digit())
            && matches!(extension, "png" | "svg")
    });
    if !clipboard && !(name.starts_with("browser-screenshot-") && name.ends_with(".png")) {
        return Ok(false);
    }
    let original = physical_file(&source)?;
    let canonical = physical_file(target)?;
    if original.identity.is_some() && original.identity == canonical.identity {
        return Ok(true);
    }
    // A multiply-linked source could already share a user's external original. Never adopt it.
    if original.links != 1
        || fs::metadata(&source)
            .map_err(|_| "storage_io_failed")?
            .permissions()
            .readonly()
        || sha256_file(&source)? != sha256_file(target)?
    {
        return Ok(false);
    }
    let parent = source.parent().ok_or("storage_invalid_path")?;
    let directory = tempfile::Builder::new()
        .prefix(".attachment-alias-")
        .tempdir_in(parent)
        .map_err(|_| "storage_io_failed")?;
    let alias = directory.path().join("alias");
    match fs::hard_link(target, &alias) {
        Ok(()) => {}
        Err(error) if link_unavailable(&error) => return Ok(false),
        Err(_) => return Err("storage_io_failed".into()),
    }
    validate_path(&source)?;
    if physical_file(&source)?.identity != original.identity {
        return Err("storage_invalid_path".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::{
            core::PCWSTR,
            Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            },
        };
        let from: Vec<u16> = alias.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            MoveFileExW(
                PCWSTR(from.as_ptr()),
                PCWSTR(to.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
        .map_err(|_| "storage_io_failed")?;
    }
    #[cfg(not(windows))]
    fs::rename(&alias, &source).map_err(|_| "storage_io_failed")?;
    Ok(true)
}

pub(crate) fn mark_immutable(path: &Path) -> Result<(), String> {
    // This prevents accidental writes; it is not a sandbox against an authorized full-access tool.
    let mut permissions = fs::metadata(path)
        .map_err(|_| "storage_io_failed")?
        .permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions).map_err(|_| "storage_io_failed".into())
}

pub(crate) fn link_unavailable(error: &io::Error) -> bool {
    if error.kind() == io::ErrorKind::Unsupported {
        return true;
    }
    #[cfg(unix)]
    if matches!(
        error.raw_os_error(),
        Some(libc::EXDEV | libc::EOPNOTSUPP | libc::EMLINK)
    ) {
        return true;
    }
    #[cfg(windows)]
    if matches!(error.raw_os_error(), Some(1 | 17 | 50 | 1142)) {
        return true;
    }
    false
}

/// Pin ancestors during a deletion, then recheck physical identity before unlinking.
pub(crate) fn remove_owned(
    root: &Path,
    path: &Path,
    expected: &FileIdentity,
) -> Result<(), String> {
    validate_path(path)?;
    if !path.starts_with(root) || path == root {
        return Err("storage_invalid_path".into());
    }
    #[cfg(unix)]
    {
        use std::{
            ffi::CString,
            os::{
                fd::AsRawFd,
                unix::{ffi::OsStrExt, fs::OpenOptionsExt},
            },
        };
        let parent = path.parent().ok_or("storage_invalid_path")?;
        let mut directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open("/")
            .map_err(|_| "storage_io_failed")?;
        for component in parent.components() {
            if let Component::Normal(name) = component {
                let name = CString::new(name.as_bytes()).map_err(|_| "storage_invalid_path")?;
                let fd = unsafe {
                    libc::openat(
                        directory.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if fd < 0 {
                    return Err("storage_invalid_path".into());
                }
                use std::os::fd::FromRawFd;
                directory = unsafe { File::from_raw_fd(fd) };
            }
        }
        let leaf = CString::new(path.file_name().ok_or("storage_invalid_path")?.as_bytes())
            .map_err(|_| "storage_invalid_path")?;
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                leaf.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err("storage_io_failed".into());
        }
        use std::os::fd::FromRawFd;
        let file = unsafe { File::from_raw_fd(fd) };
        if physical_handle(&file)?.identity.as_ref() != Some(expected) {
            return Err("storage_invalid_path".into());
        }
        // Rename to a private name first: unlinking the leaf after checking a separate
        // handle would delete whatever another process placed there in the meantime.
        let quarantine_name = format!(".storage-delete-{}", uuid::Uuid::new_v4());
        let quarantine =
            CString::new(quarantine_name.as_bytes()).map_err(|_| "storage_invalid_path")?;
        if unsafe {
            libc::renameat(
                directory.as_raw_fd(),
                leaf.as_ptr(),
                directory.as_raw_fd(),
                quarantine.as_ptr(),
            )
        } != 0
        {
            return Err("storage_io_failed".into());
        }
        let quarantine_fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                quarantine.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if quarantine_fd < 0 {
            return Err("storage_io_failed".into());
        }
        let quarantined = unsafe { File::from_raw_fd(quarantine_fd) };
        if physical_handle(&quarantined)?.identity.as_ref() != Some(expected) {
            // Never delete or overwrite whoever won the name race; leave it recoverable.
            return Err("storage_invalid_path".into());
        }
        drop(quarantined);
        drop(file);
        if unsafe { libc::unlinkat(directory.as_raw_fd(), quarantine.as_ptr(), 0) } != 0 {
            return Err("storage_io_failed".into());
        }
        return Ok(());
    }
    #[cfg(windows)]
    {
        use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
        use windows::Win32::{
            Foundation::HANDLE,
            Storage::FileSystem::{
                FileDispositionInfoEx, SetFileInformationByHandle, DELETE,
                FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
                FILE_DISPOSITION_INFO_EX, FILE_DISPOSITION_INFO_EX_FLAGS,
                FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ,
                FILE_SHARE_READ, FILE_SHARE_WRITE,
            },
        };
        let mut parents = Vec::new();
        for ancestor in path
            .parent()
            .ok_or("storage_invalid_path")?
            .ancestors()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
        {
            let parent = OpenOptions::new()
                .read(true)
                .share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE).0)
                .custom_flags((FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT).0)
                .open(ancestor)
                .map_err(|_| "storage_invalid_path")?;
            if is_reparse(&parent.metadata().map_err(|_| "storage_invalid_path")?) {
                return Err("storage_invalid_path".into());
            }
            parents.push(parent);
        }
        let file = OpenOptions::new()
            .access_mode((FILE_GENERIC_READ | DELETE).0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
            .open(path)
            .map_err(|_| "storage_io_failed")?;
        if is_reparse(&file.metadata().map_err(|_| "storage_invalid_path")?)
            || physical_handle(&file)?.identity.as_ref() != Some(expected)
        {
            return Err("storage_invalid_path".into());
        }
        let disposition = FILE_DISPOSITION_INFO_EX {
            Flags: FILE_DISPOSITION_INFO_EX_FLAGS(
                FILE_DISPOSITION_FLAG_DELETE.0 | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE.0,
            ),
        };
        unsafe {
            SetFileInformationByHandle(
                HANDLE(file.as_raw_handle()),
                FileDispositionInfoEx,
                (&disposition as *const FILE_DISPOSITION_INFO_EX).cast(),
                std::mem::size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
            )
        }
        .map_err(|_| "storage_io_failed")?;
        return Ok(());
    }
    #[cfg(not(any(unix, windows)))]
    Err("storage_io_failed".into())
}
