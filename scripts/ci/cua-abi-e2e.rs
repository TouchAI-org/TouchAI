use std::ffi::{c_void, CString};
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[repr(C)]
struct Buf {
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

type Status = i32;
type Completion = extern "C" fn(*mut c_void, Status, Buf, Buf);
type InvokeFn = unsafe extern "C" fn(
    *mut c_void,
    *const u8,
    usize,
    *const u8,
    usize,
    Completion,
    *mut c_void,
    *mut *mut c_void,
    *mut Buf,
) -> Status;

struct Driver {
    _lib: libloading::Library,
    handle: *mut c_void,
    invoke: InvokeFn,
    destroy: unsafe extern "C" fn(*mut *mut c_void),
}

unsafe fn bytes(buf: &Buf) -> Vec<u8> {
    if buf.data.is_null() || buf.len == 0 {
        Vec::new()
    } else {
        std::slice::from_raw_parts(buf.data, buf.len).to_vec()
    }
}

impl Driver {
    fn open(path: &str) -> Result<Self, String> {
        unsafe {
            let lib = libloading::Library::new(path).map_err(|e| e.to_string())?;
            let abi_version: libloading::Symbol<unsafe extern "C" fn(*mut AbiVersion) -> Status> =
                lib.get(b"cua_driver_abi_version_v1").map_err(|e| e.to_string())?;
            let mut version = AbiVersion {
                struct_size: std::mem::size_of::<AbiVersion>() as u32,
                major: 0,
                minor: 0,
                patch: 0,
                reserved: 0,
            };
            let status = abi_version(&mut version);
            println!("abi {}.{}.{} (status {status})", version.major, version.minor, version.patch);

            let create: libloading::Symbol<
                unsafe extern "C" fn(*const u8, usize, *mut *mut c_void, *mut Buf) -> Status,
            > = lib
                .get(b"cua_driver_create_v1")
                .map_err(|e| e.to_string())?;
            let options = b"{}";
            let mut handle: *mut c_void = std::ptr::null_mut();
            let mut error = Buf {
                data: std::ptr::null_mut(),
                len: 0,
                capacity: 0,
            };
            let status = create(options.as_ptr(), options.len(), &mut handle, &mut error);
            if status != 0 {
                return Err(unsafe { String::from_utf8_lossy(&bytes(&error)).to_string() });
            }

            Ok(Self {
                handle,
                invoke: *lib
                    .get(b"cua_driver_invoke_v1")
                    .map_err(|e| e.to_string())?,
                destroy: *lib
                    .get(b"cua_driver_destroy_v1")
                    .map_err(|e| e.to_string())?,
                _lib: lib,
            })
        }
    }

    fn call(&self, tool: &str, args: &str) -> Result<serde_json::Value, String> {
        extern "C" fn done(ctx: *mut c_void, status: Status, result: Buf, error: Buf) {
            let sender = unsafe { &*(ctx as *const mpsc::Sender<(Status, Vec<u8>, Vec<u8>)>) };
            let _ = sender.send(unsafe { (status, bytes(&result), bytes(&error)) });
        }

        let name = CString::new(tool).map_err(|e| e.to_string())?;
        let (sender, receiver) = mpsc::channel::<(Status, Vec<u8>, Vec<u8>)>();
        let mut operation: *mut c_void = std::ptr::null_mut();
        let mut error = Buf {
            data: std::ptr::null_mut(),
            len: 0,
            capacity: 0,
        };
        let status = unsafe {
            (self.invoke)(
                self.handle,
                name.as_bytes().as_ptr(),
                name.as_bytes().len(),
                args.as_ptr(),
                args.len(),
                done,
                &sender as *const _ as *mut c_void,
                &mut operation,
                &mut error,
            )
        };
        if status != 0 {
            let error = unsafe { bytes(&error) };
            return Err(format!(
                "invoke {tool} rejected: {}",
                String::from_utf8_lossy(&error)
            ));
        }
        let (status, result, error) = receiver
            .recv_timeout(Duration::from_secs(20))
            .map_err(|e| format!("{tool} timed out: {e}"))?;
        if status != 0 {
            return Err(format!(
                "{tool} failed: {}",
                String::from_utf8_lossy(&error)
            ));
        }
        serde_json::from_slice(&result).map_err(|e| format!("{tool} bad json: {e}"))
    }

    /// Unwraps the MCP envelope into the structured payload.
    fn payload(&self, tool: &str, args: &str) -> Result<serde_json::Value, String> {
        let envelope = self.call(tool, args)?;
        if envelope["isError"].as_bool() == Some(true) {
            return Err(format!("{tool}: {}", envelope["content"][0]["text"]));
        }
        if !envelope["structuredContent"].is_null() {
            return Ok(envelope["structuredContent"].clone());
        }
        Ok(envelope)
    }
}

impl Drop for Driver {
    fn drop(&mut self) {
        unsafe { (self.destroy)(&mut self.handle) };
    }
}

fn main() {
    let path = std::env::args().nth(1).expect("path to cua_driver_sdk.dll");
    let driver = Driver::open(&path).expect("open driver");

    let started = Instant::now();
    let windows = driver
        .payload("list_windows", "{}")
        .expect("list_windows");
    let target = windows["windows"]
        .as_array()
        .and_then(|list| {
            list.iter().find(|w| {
                w["title"]
                    .as_str()
                    .map(|t| t.contains("计算器") || t.contains("Calculator"))
                    .unwrap_or(false)
            })
        })
        .cloned()
        .expect("calculator window");
    let pid = target["pid"].as_i64().expect("pid");
    let window_id = target["window_id"].as_i64().expect("window_id");
    println!("target pid={pid} window_id={window_id}");

    let snapshot_args = serde_json::json!({
        "pid": pid,
        "window_id": window_id,
        "include_screenshot": false,
        "tree_format": "elements"
    });
    let first = driver
        .payload("get_window_state", &snapshot_args.to_string())
        .expect("snapshot");
    let display = |state: &serde_json::Value| -> Option<String> {
        state["elements"].as_array().and_then(|list| {
            list.iter()
                .find_map(|e| e["label"].as_str().filter(|l| l.starts_with("显示为")).map(str::to_string))
        })
    };
    println!("before: {:?} ({} elements)", display(&first), first["element_count"]);

    let token_of = |state: &serde_json::Value, label: &str| -> String {
        state["elements"]
            .as_array()
            .and_then(|list| list.iter().find(|e| e["label"] == label))
            .and_then(|e| e["element_token"].as_str())
            .unwrap_or_else(|| panic!("no element {label}"))
            .to_string()
    };

    for label in ["清除", "六", "乘以", "七", "等于"] {
        let token = token_of(&first, label);
        let click_args = serde_json::json!({
            "pid": pid,
            "window_id": window_id,
            "element_token": token,
            "delivery_mode": "background"
        });
        let t0 = Instant::now();
        let result = driver
            .payload("click", &click_args.to_string())
            .unwrap_or_else(|e| panic!("click {label}: {e}"));
        println!(
            "click {label}: route={} effect={} ({} ms)",
            result["route"],
            result["effect"],
            t0.elapsed().as_millis()
        );
    }

    let second = driver
        .payload("get_window_state", &snapshot_args.to_string())
        .expect("verify snapshot");
    let after = display(&second);
    println!("after: {:?}", after);
    println!("total {} ms", started.elapsed().as_millis());

    let ok = after.as_deref() == Some("显示为 42");
    println!("{}", if ok { "E2E PASS: 6 x 7 = 42" } else { "E2E FAIL" });
    std::process::exit(if ok { 0 } else { 1 });
}
