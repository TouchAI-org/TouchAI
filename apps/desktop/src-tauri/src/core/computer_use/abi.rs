// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 进程内 cua-driver 运行时（C ABI 1.x）的安全封装。
//!
//! 只依赖 `libloading` 与 `serde_json`：上游不发布 Rust crate，
//! 稳定边界是 `rust/include/cua_driver_abi.h` 的 15 个导出函数。
//! 所有结果都是 JSON 缓冲，异步完成通过回调送回，取消通过操作令牌完成。

use std::ffi::{c_void, CString};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

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
    invoke: InvokeFn,
    cancel: CancelFn,
    release: ReleaseFn,
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
            Ok(Self {
                buffer_free: std::mem::transmute(symbol(b"cua_driver_buffer_free_v1")?),
                create: std::mem::transmute(symbol(b"cua_driver_create_v1")?),
                destroy: std::mem::transmute(symbol(b"cua_driver_destroy_v1")?),
                is_available: std::mem::transmute(symbol(b"cua_driver_is_available_v1")?),
                metadata: std::mem::transmute(symbol(b"cua_driver_metadata_json_v1")?),
                invoke: std::mem::transmute(symbol(b"cua_driver_invoke_v1")?),
                cancel: std::mem::transmute(symbol(b"cua_driver_operation_cancel_v1")?),
                release: std::mem::transmute(symbol(b"cua_driver_operation_release_v1")?),
                _library: library,
            })
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
}

unsafe impl Send for Driver {}
unsafe impl Sync for Driver {}

struct CallContext {
    id: u64,
    driver: *const Driver,
    sender: tokio::sync::oneshot::Sender<Result<Value, AbiError>>,
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
        unsafe {
            let mut json = empty_buffer();
            let mut error = empty_buffer();
            let status = (self.library.metadata)(self.handle, &mut json, &mut error);
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
    pub fn invoke(&self, tool: &str, arguments: &Value) -> Result<PendingCall, AbiError> {
        let name = CString::new(tool).map_err(|error| AbiError::Json(error.to_string()))?;
        let arguments =
            serde_json::to_string(arguments).map_err(|error| AbiError::Json(error.to_string()))?;

        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let context = Box::new(CallContext {
            id,
            driver: self as *const Driver,
            sender,
        });

        let mut operation: *mut c_void = std::ptr::null_mut();
        let mut error = empty_buffer();
        let status = unsafe {
            (self.library.invoke)(
                self.handle,
                name.as_bytes().as_ptr(),
                name.as_bytes().len(),
                arguments.as_ptr(),
                arguments.len(),
                completed,
                Box::into_raw(context) as *mut c_void,
                &mut operation,
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

        self.pending
            .lock()
            .expect("pending calls")
            .insert(id, operation as usize);

        Ok(PendingCall { id, receiver })
    }

    /// 请求取消一次在途调用；令牌在完成后由回调清理。
    pub fn cancel(&self, id: u64) -> bool {
        let operation = self
            .pending
            .lock()
            .expect("pending calls")
            .get(&id)
            .copied();
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
    let driver = unsafe { &*context.driver };
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
        unsafe { (self.library.destroy)(&mut self.handle) };
    }
}
