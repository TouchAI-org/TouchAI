// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 进程内 cua-driver 运行时（C ABI 1.x）的安全封装。
//!
//! 只依赖 `libloading` 与 `serde_json`：上游不发布 Rust crate，
//! 稳定边界是 `rust/include/cua_driver_abi.h` 的 15 个导出函数。
//! 所有结果都是 JSON 缓冲，异步完成通过回调送回，取消通过操作令牌完成。

use std::ffi::{c_void, CString};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::Value;

type Status = i32;
const STATUS_OK: Status = 0;

#[repr(C)]
struct AbiBuffer {
    data: *mut u8,
    len: usize,
    capacity: usize,
}

#[repr(C)]
struct AbiVersion {
    struct_size: u32,
    major: u16,
    minor: u16,
    patch: u16,
    reserved: u16,
}

type Completion = extern "C" fn(*mut c_void, Status, AbiBuffer, AbiBuffer);

type AbiVersionFn = unsafe extern "C" fn(*mut AbiVersion) -> Status;
type IsCompatibleFn = unsafe extern "C" fn(u16, u16) -> bool;
type BufferFreeFn = unsafe extern "C" fn(*mut AbiBuffer);
type CreateFn = unsafe extern "C" fn(*const u8, usize, *mut *mut c_void, *mut AbiBuffer) -> Status;
type DestroyFn = unsafe extern "C" fn(*mut *mut c_void);
type IsAvailableFn = unsafe extern "C" fn(*mut c_void, *mut bool, *mut AbiBuffer) -> Status;
type MetadataFn = unsafe extern "C" fn(*mut c_void, *mut AbiBuffer, *mut AbiBuffer) -> Status;
type InvokeFn = unsafe extern "C" fn(
    *mut c_void,
    *const u8,
    usize,
    *const u8,
    usize,
    Completion,
    *mut c_void,
    *mut *mut c_void,
    *mut AbiBuffer,
) -> Status;
type CancelFn = unsafe extern "C" fn(*mut c_void);
type ReleaseFn = unsafe extern "C" fn(*mut *mut c_void);
type SessionCreateFn =
    unsafe extern "C" fn(*mut c_void, *const u8, usize, *mut *mut c_void, *mut AbiBuffer) -> Status;

#[derive(Debug)]
pub enum AbiError {
    Library(String),
    Symbol(String),
    Status { code: Status, message: String },
    Json(String),
}

impl std::fmt::Display for AbiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Library(message) => write!(f, "failed to load the driver library: {message}"),
            Self::Symbol(message) => write!(f, "driver library is missing a symbol: {message}"),
            Self::Status { code, message } => write!(f, "driver call failed ({code}): {message}"),
            Self::Json(message) => write!(f, "driver returned invalid JSON: {message}"),
        }
    }
}

impl std::error::Error for AbiError {}

pub struct AbiVersionInfo {
    pub major: u16,
    pub minor: u16,
    pub patch: u16,
}

impl std::fmt::Display for AbiVersionInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

unsafe fn take_bytes(buffer: &AbiBuffer) -> Vec<u8> {
    if buffer.data.is_null() || buffer.len == 0 {
        Vec::new()
    } else {
        std::slice::from_raw_parts(buffer.data, buffer.len).to_vec()
    }
}

fn empty_buffer() -> AbiBuffer {
    AbiBuffer {
        data: std::ptr::null_mut(),
        len: 0,
        capacity: 0,
    }
}

/// 一个已加载的运行时候选。加载与创建分开，便于先做健康检查再决定是否创建。
pub struct AbiLibrary {
    _library: libloading::Library,
    buffer_free: BufferFreeFn,
    create: CreateFn,
    destroy: DestroyFn,
    is_available: IsAvailableFn,
    metadata: MetadataFn,
    list_tools: MetadataFn,
    invoke: InvokeFn,
    cancel: CancelFn,
    release: ReleaseFn,
    session_create: SessionCreateFn,
    session_destroy: DestroyFn,
    session_invoke: InvokeFn,
}

impl AbiLibrary {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, AbiError> {
        let path = path.as_ref();
        if !path.is_file() {
            return Err(AbiError::Library(format!(
                "{} does not exist",
                path.display()
            )));
        }
        unsafe {
            let library = libloading::Library::new(path)
                .map_err(|error| AbiError::Library(error.to_string()))?;
            let symbol = |name: &[u8]| -> Result<*mut c_void, AbiError> {
                library
                    .get::<*mut c_void>(name)
                    .map(|symbol| *symbol)
                    .map_err(|error| AbiError::Symbol(error.to_string()))
            };
            let loaded = Self {
                buffer_free: std::mem::transmute(symbol(b"cua_driver_buffer_free_v1")?),
                create: std::mem::transmute(symbol(b"cua_driver_create_v1")?),
                destroy: std::mem::transmute(symbol(b"cua_driver_destroy_v1")?),
                is_available: std::mem::transmute(symbol(b"cua_driver_is_available_v1")?),
                metadata: std::mem::transmute(symbol(b"cua_driver_metadata_json_v1")?),
                list_tools: std::mem::transmute(symbol(b"cua_driver_list_tools_json_v1")?),
                invoke: std::mem::transmute(symbol(b"cua_driver_invoke_v1")?),
                cancel: std::mem::transmute(symbol(b"cua_driver_operation_cancel_v1")?),
                release: std::mem::transmute(symbol(b"cua_driver_operation_release_v1")?),
                session_create: std::mem::transmute(symbol(b"cua_driver_session_create_v1")?),
                session_destroy: std::mem::transmute(symbol(b"cua_driver_session_destroy_v1")?),
                session_invoke: std::mem::transmute(symbol(b"cua_driver_session_invoke_v1")?),
                _library: library,
            };
            #[cfg(windows)]
            libloading::os::windows::Library::open_already_loaded(path)
                .and_then(|library| library.pin())
                .map_err(|error| AbiError::Library(error.to_string()))?;
            Ok(loaded)
        }
    }

    pub fn version(path: impl AsRef<Path>) -> Result<AbiVersionInfo, AbiError> {
        let library = AbiLibrary::open(path)?;
        unsafe {
            let version: libloading::Symbol<AbiVersionFn> = library
                ._library
                .get(b"cua_driver_abi_version_v1")
                .map_err(|error| AbiError::Symbol(error.to_string()))?;
            let mut info = AbiVersion {
                struct_size: std::mem::size_of::<AbiVersion>() as u32,
                major: 0,
                minor: 0,
                patch: 0,
                reserved: 0,
            };
            let status = version(&mut info);
            if status != STATUS_OK {
                return Err(AbiError::Status {
                    code: status,
                    message: "abi_version failed".to_string(),
                });
            }
            Ok(AbiVersionInfo {
                major: info.major,
                minor: info.minor,
                patch: info.patch,
            })
        }
    }

    pub fn is_compatible(&self, major: u16, minor: u16) -> Result<bool, AbiError> {
        unsafe {
            let is_compatible: libloading::Symbol<IsCompatibleFn> = self
                ._library
                .get(b"cua_driver_abi_is_compatible_v1")
                .map_err(|error| AbiError::Symbol(error.to_string()))?;
            Ok(is_compatible(major, minor))
        }
    }

    /// 创建运行时。`options_json` 为空或一个 JSON 对象，未知字段会失败。
    pub fn create(self, options_json: &str) -> Result<Driver, AbiError> {
        unsafe {
            let mut handle: *mut c_void = std::ptr::null_mut();
            let mut error = empty_buffer();
            let status = (self.create)(
                options_json.as_ptr(),
                options_json.len(),
                &mut handle,
                &mut error,
            );
            let message = take_bytes(&error);
            (self.buffer_free)(&mut error);
            if status != STATUS_OK {
                return Err(AbiError::Status {
                    code: status,
                    message: String::from_utf8_lossy(&message).to_string(),
                });
            }
            Ok(Driver {
                handle,
                library: std::sync::Arc::new(self),
                pending: Mutex::new(std::collections::HashMap::new()),
                next_id: AtomicU64::new(1),
                tools: OnceLock::new(),
                sessions: Mutex::new(std::collections::HashMap::new()),
            })
        }
    }
}

/// 一次可取消的调用。
pub struct PendingCall {
    pub id: u64,
    pub receiver: tokio::sync::oneshot::Receiver<Result<Value, AbiError>>,
}

pub struct Driver {
    handle: *mut c_void,
    library: std::sync::Arc<AbiLibrary>,
    pending: Mutex<std::collections::HashMap<u64, usize>>,
    next_id: AtomicU64,
    tools: OnceLock<Vec<Value>>,
    sessions: Mutex<std::collections::HashMap<String, Arc<TrustedSession>>>,
}

unsafe impl Send for Driver {}
unsafe impl Sync for Driver {}

struct CallContext {
    id: u64,
    driver: Arc<Driver>,
    sender: tokio::sync::oneshot::Sender<Result<Value, AbiError>>,
    _session: Option<Arc<TrustedSession>>,
}

struct TrustedSession {
    handle: *mut c_void,
    library: Arc<AbiLibrary>,
    last_used: Mutex<std::time::Instant>,
    created: std::time::Instant,
}

unsafe impl Send for TrustedSession {}
unsafe impl Sync for TrustedSession {}

impl Drop for TrustedSession {
    fn drop(&mut self) {
        unsafe { (self.library.session_destroy)(&mut self.handle) };
    }
}

impl Driver {
    pub fn sync_state(&self) -> bool {
        self.is_available()
    }

    pub fn is_available(&self) -> bool {
        unsafe {
            let mut available = false;
            let mut error = empty_buffer();
            let status = (self.library.is_available)(self.handle, &mut available, &mut error);
            (self.library.buffer_free)(&mut error);
            status == STATUS_OK && available
        }
    }

    pub fn metadata(&self) -> Result<Value, AbiError> {
        self.read_json(self.library.metadata)
    }

    pub fn list_tools(&self) -> Result<&Vec<Value>, AbiError> {
        if let Some(tools) = self.tools.get() {
            return Ok(tools);
        }
        let catalog = self.read_json(self.library.list_tools)?;
        let tools = catalog
            .get("tools")
            .and_then(Value::as_array)
            .ok_or_else(|| AbiError::Json("tool catalog must contain a tools array".to_string()))?;
        let _ = self.tools.set(tools.clone());
        self.tools
            .get()
            .ok_or_else(|| AbiError::Json("tool catalog unavailable".to_string()))
    }

    fn read_json(&self, function: MetadataFn) -> Result<Value, AbiError> {
        unsafe {
            let mut json = empty_buffer();
            let mut error = empty_buffer();
            let status = function(self.handle, &mut json, &mut error);
            let payload = take_bytes(&json);
            let message = take_bytes(&error);
            (self.library.buffer_free)(&mut json);
            (self.library.buffer_free)(&mut error);
            if status != STATUS_OK {
                return Err(AbiError::Status {
                    code: status,
                    message: String::from_utf8_lossy(&message).to_string(),
                });
            }
            serde_json::from_slice(&payload).map_err(|error| AbiError::Json(error.to_string()))
        }
    }

    /// 发起一次调用并立即返回可取消句柄。
    pub fn invoke(
        self: &Arc<Self>,
        tool: &str,
        arguments: &Value,
        full_access: bool,
    ) -> Result<PendingCall, AbiError> {
        let session = if full_access {
            Some(self.trusted_session(arguments)?)
        } else {
            None
        };
        self.invoke_bound(tool, arguments, session)
    }

    fn invoke_bound(
        self: &Arc<Self>,
        tool: &str,
        arguments: &Value,
        session: Option<Arc<TrustedSession>>,
    ) -> Result<PendingCall, AbiError> {
        let handle = session
            .as_ref()
            .map_or(self.handle, |session| session.handle);
        let invoke = if session.is_some() {
            self.library.session_invoke
        } else {
            self.library.invoke
        };
        let name = CString::new(tool).map_err(|error| AbiError::Json(error.to_string()))?;
        let arguments =
            serde_json::to_string(arguments).map_err(|error| AbiError::Json(error.to_string()))?;

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let context = Box::new(CallContext {
            id,
            driver: Arc::clone(self),
            sender,
            _session: session,
        });
        let context = Box::into_raw(context);
        self.pending.lock().expect("pending calls").insert(id, 0);

        let mut operation: *mut c_void = std::ptr::null_mut();
        let mut error = empty_buffer();
        let status = unsafe {
            invoke(
                handle,
                name.as_bytes().as_ptr(),
                name.as_bytes().len(),
                arguments.as_ptr(),
                arguments.len(),
                completed,
                context as *mut c_void,
                &mut operation,
                &mut error,
            )
        };
        let message = unsafe { take_bytes(&error) };
        unsafe { (self.library.buffer_free)(&mut error) };

        if status != STATUS_OK {
            self.pending.lock().expect("pending calls").remove(&id);
            unsafe {
                drop(Box::from_raw(context));
            }
            return Err(AbiError::Status {
                code: status,
                message: String::from_utf8_lossy(&message).to_string(),
            });
        }

        let mut pending = self.pending.lock().expect("pending calls");
        if let Some(slot) = pending.get_mut(&id) {
            *slot = operation as usize;
        } else {
            unsafe { (self.library.release)(&mut operation) };
        }

        Ok(PendingCall { id, receiver })
    }

    fn trusted_session(
        self: &Arc<Self>,
        arguments: &Value,
    ) -> Result<Arc<TrustedSession>, AbiError> {
        let label = arguments["session"]
            .as_str()
            .unwrap_or("touchai-full-access");
        let mut sessions = self.sessions.lock().expect("trusted sessions");
        sessions.retain(|_, session| {
            session.created.elapsed().as_secs() < 86000
                && session
                    .last_used
                    .lock()
                    .expect("session clock")
                    .elapsed()
                    .as_secs()
                    < 3500
        });
        if let Some(session) = sessions.get(label) {
            *session.last_used.lock().expect("session clock") = std::time::Instant::now();
            return Ok(Arc::clone(session));
        }
        if sessions.len() >= 32 {
            return Err(AbiError::Json(
                "too many active computer use sessions; end an unused session".to_string(),
            ));
        }
        let options = serde_json::json!({"public_session": label, "transport_session": format!("touchai:{label}"), "mode": "unrestricted", "ttl_seconds": 86400, "idle_ttl_seconds": 3600}).to_string();
        let mut handle = std::ptr::null_mut();
        let mut error = empty_buffer();
        let status = unsafe {
            (self.library.session_create)(
                self.handle,
                options.as_ptr(),
                options.len(),
                &mut handle,
                &mut error,
            )
        };
        let message = unsafe { take_bytes(&error) };
        unsafe { (self.library.buffer_free)(&mut error) };
        if status != STATUS_OK {
            return Err(AbiError::Status {
                code: status,
                message: String::from_utf8_lossy(&message).to_string(),
            });
        }
        let session = Arc::new(TrustedSession {
            handle,
            library: Arc::clone(&self.library),
            created: std::time::Instant::now(),
            last_used: Mutex::new(std::time::Instant::now()),
        });
        let mut started = self.invoke_bound(
            "start_session",
            &serde_json::json!({}),
            Some(Arc::clone(&session)),
        )?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match started.receiver.try_recv() {
                Ok(result) => {
                    let result = result?;
                    if result["isError"].as_bool() == Some(true) {
                        return Err(AbiError::Status {
                            code: -1,
                            message: result.to_string(),
                        });
                    }
                    break;
                }
                Err(tokio::sync::oneshot::error::TryRecvError::Empty)
                    if std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                _ => {
                    self.cancel(started.id);
                    return Err(AbiError::Status {
                        code: -1,
                        message: "computer use session did not start".to_string(),
                    });
                }
            }
        }
        sessions.insert(label.to_string(), Arc::clone(&session));
        Ok(session)
    }

    pub fn end_session(&self, arguments: &Value) {
        let label = arguments["session"]
            .as_str()
            .unwrap_or("touchai-full-access");
        self.sessions
            .lock()
            .expect("trusted sessions")
            .remove(label);
    }

    pub fn end_activity(&self, activity_id: &str) {
        let prefix = format!("{activity_id}-");
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.retain(|label, _| !label.starts_with(&prefix));
        }
    }

    /// 请求取消一次在途调用；令牌在完成后由回调清理。
    pub fn cancel(&self, id: u64) -> bool {
        let pending = self.pending.lock().expect("pending calls");
        let operation = pending.get(&id).copied();
        match operation {
            Some(operation) if operation != 0 => {
                unsafe { (self.library.cancel)(operation as *mut c_void) };
                true
            }
            _ => false,
        }
    }
}

extern "C" fn completed(context: *mut c_void, status: Status, result: AbiBuffer, error: AbiBuffer) {
    if context.is_null() {
        return;
    }
    let context = unsafe { Box::from_raw(context as *mut CallContext) };
    let driver = &context.driver;
    let payload = unsafe { take_bytes(&result) };
    let message = unsafe { take_bytes(&error) };
    unsafe {
        (driver.library.buffer_free)(&mut { result });
        (driver.library.buffer_free)(&mut { error });
    }

    if let Some(operation) = driver
        .pending
        .lock()
        .expect("pending calls")
        .remove(&context.id)
    {
        let mut operation = operation as *mut c_void;
        unsafe { (driver.library.release)(&mut operation) };
    }

    let outcome = if status == STATUS_OK {
        serde_json::from_slice(&payload).map_err(|error| AbiError::Json(error.to_string()))
    } else {
        Err(AbiError::Status {
            code: status,
            message: String::from_utf8_lossy(&message).to_string(),
        })
    };
    let _ = context.sender.send(outcome);
}

impl Drop for Driver {
    fn drop(&mut self) {
        if let Ok(sessions) = self.sessions.get_mut() {
            sessions.clear();
        }
        unsafe { (self.library.destroy)(&mut self.handle) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    #[ignore = "requires TOUCHAI_TEST_CUA_DLL"]
    fn user_given_a_retired_runtime_when_native_callbacks_finish_then_their_library_remains_mapped()
    {
        let path = std::env::var("TOUCHAI_TEST_CUA_DLL").expect("native fixture library");
        let library = AbiLibrary::open(&path).expect("load library");
        drop(library);
        assert!(libloading::os::windows::Library::open_already_loaded(&path).is_ok());
    }

    fn complete(mut pending: PendingCall) -> Value {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match pending.receiver.try_recv() {
                Ok(result) => return result.expect("native result"),
                Err(tokio::sync::oneshot::error::TryRecvError::Empty)
                    if std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                result => panic!("native call did not complete: {result:?}"),
            }
        }
    }

    #[test]
    fn user_given_a_retired_trusted_session_when_reading_again_then_receives_a_live_session() {
        let Ok(path) = std::env::var("TOUCHAI_TEST_CUA_DLL") else {
            return;
        };
        let driver = Arc::new(AbiLibrary::open(path).expect("installed driver").create(
            &serde_json::json!({"authorization":{"allowed_modes":["standard","unrestricted"],"compatibility_mode":"standard","unrestricted_acknowledged":true,"max_session_ttl_seconds":86400,"max_idle_ttl_seconds":3600}}).to_string()
        ).expect("driver runtime"));
        let args = serde_json::json!({"session":"touchai-native-session-regression"});
        let first = complete(
            driver
                .invoke("get_config", &args, true)
                .expect("first read"),
        );
        assert_ne!(first["isError"], true, "{first}");
        let ended = complete(
            driver
                .invoke("end_session", &args, true)
                .expect("end session"),
        );
        assert_ne!(ended["isError"], true, "{ended}");
        driver.end_session(&args);
        let second = complete(
            driver
                .invoke("get_config", &args, true)
                .expect("read after retirement"),
        );
        assert_ne!(second["isError"], true, "{second}");
    }
}
