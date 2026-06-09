use std::{
    collections::HashSet,
    env, fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

#[cfg(target_os = "linux")]
use std::ffi::OsString;

use super::{
    endpoint::BrowserEndpoint,
    types::{BrowserDescriptor, BrowserFingerprintMode, BrowserStartRequest},
    url_policy::validate_browser_url,
};
use crate::core::system::paths::{app_directory_path, AppDirectory};

const DEFAULT_BROWSER_DATA_DIR_NAME: &str = "browser-data";

#[derive(Debug)]
pub struct ManagedBrowserProcess {
    child: Child,
    profile_dir: Option<ManagedProfileDir>,
}

#[derive(Debug)]
struct ManagedProfileDir(PathBuf);

impl ManagedProfileDir {
    fn path(&self) -> &Path {
        self.0.as_path()
    }
}

impl Drop for ManagedBrowserProcess {
    fn drop(&mut self) {
        let child_is_running = self
            .child
            .try_wait()
            .map(|status| status.is_none())
            .unwrap_or(true);
        if child_is_running {
            kill_process_tree(self.child.id());
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

impl ManagedBrowserProcess {
    fn profile_path(&self) -> &Path {
        self.profile_dir
            .as_ref()
            .expect("managed browser profile dir")
            .path()
    }
}

pub fn discover_installed_browsers() -> Vec<BrowserDescriptor> {
    let mut browsers = Vec::new();
    for (id, name, path) in candidate_browser_paths() {
        if path.is_file() {
            browsers.push(BrowserDescriptor {
                id: id.to_string(),
                name: name.to_string(),
                path,
            });
        }
    }
    browsers
}

pub fn default_managed_browser_data_path() -> Result<PathBuf, String> {
    Ok(app_directory_path(AppDirectory::Data)?.join(DEFAULT_BROWSER_DATA_DIR_NAME))
}

pub fn launch_managed_browser(
    request: BrowserStartRequest,
) -> Result<(BrowserEndpoint, ManagedBrowserProcess), String> {
    let startup_url = request
        .startup_url
        .as_deref()
        .map(validate_browser_url)
        .transpose()?
        .unwrap_or_else(|| "about:blank".to_string());
    let browsers = discover_installed_browsers();
    let browser_path = select_browser_path(&browsers, request.browser_executable_path.as_deref())?;

    let user_data_dir = create_managed_profile_dir(request.browser_data_path.as_deref())?;

    let mut command = Command::new(&browser_path);
    command
        .arg(format!("--remote-debugging-address={}", "127.0.0.1"))
        .arg("--remote-debugging-port=0")
        .arg(format!(
            "--user-data-dir={}",
            user_data_dir.path().display()
        ))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--disable-background-networking")
        .arg(browser_window_size_arg(&request))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    append_headless_args(&mut command, &request);
    append_fingerprint_args(&mut command, &request);
    command.arg(startup_url);
    configure_child_group(&mut command);

    let child = command
        .spawn()
        .map_err(|error| format!("Failed to launch browser: {error}"))?;
    let process = ManagedBrowserProcess {
        child,
        profile_dir: Some(user_data_dir),
    };
    let endpoint = match wait_for_devtools_active_port(process.profile_path()) {
        Ok(endpoint) => endpoint,
        Err(error) => {
            drop(process);
            return Err(error);
        }
    };

    Ok((endpoint, process))
}

fn append_headless_args(command: &mut Command, request: &BrowserStartRequest) {
    if request.headless == Some(true) {
        command.arg("--headless=new");
    }
}

fn append_fingerprint_args(command: &mut Command, request: &BrowserStartRequest) {
    if request.fingerprint_mode != Some(BrowserFingerprintMode::Balanced) {
        return;
    }

    if let Some(locale) = normalized_flag_value(request.fingerprint_locale.as_deref()) {
        command.arg(format!("--lang={locale}"));
    }

    if let Some(user_agent) = normalized_flag_value(request.fingerprint_user_agent.as_deref()) {
        command.arg(format!("--user-agent={user_agent}"));
    }
}

fn browser_window_size_arg(request: &BrowserStartRequest) -> String {
    let value = if request.fingerprint_mode == Some(BrowserFingerprintMode::Balanced) {
        normalized_window_size(request.fingerprint_window_size.as_deref())
    } else {
        None
    }
    .unwrap_or_else(|| "1280,900".to_string());
    format!("--window-size={value}")
}

fn normalized_flag_value(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter(|value| !value.starts_with('-') && !value.contains('\0'))
        .map(str::to_string)
}

fn normalized_window_size(value: Option<&str>) -> Option<String> {
    let value = normalized_flag_value(value)?;
    let (width, height) = value
        .split_once(',')
        .or_else(|| value.split_once('x'))
        .or_else(|| value.split_once('X'))?;
    let width = width.trim().parse::<u32>().ok()?;
    let height = height.trim().parse::<u32>().ok()?;
    if !(800..=3840).contains(&width) || !(600..=2160).contains(&height) {
        return None;
    }
    Some(format!("{width},{height}"))
}

fn create_managed_profile_dir(
    browser_data_path: Option<&Path>,
) -> Result<ManagedProfileDir, String> {
    let default_path = default_managed_browser_data_path()?;
    create_managed_profile_dir_with_default_path(browser_data_path, &default_path)
}

fn create_managed_profile_dir_with_default_path(
    browser_data_path: Option<&Path>,
    default_path: &Path,
) -> Result<ManagedProfileDir, String> {
    let path = match browser_data_path {
        Some(path) => {
            if path.as_os_str().is_empty() {
                return Err("Browser data path cannot be empty".to_string());
            }
            path.to_path_buf()
        }
        None => default_path.to_path_buf(),
    };

    fs::create_dir_all(&path).map_err(|error| {
        format!(
            "Failed to create browser data directory {}: {error}",
            path.display()
        )
    })?;
    remove_stale_devtools_active_port(&path)?;
    Ok(ManagedProfileDir(path))
}

fn remove_stale_devtools_active_port(profile_dir: &Path) -> Result<(), String> {
    let path = profile_dir.join("DevToolsActivePort");
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Failed to clear stale DevToolsActivePort {}: {error}",
            path.display()
        )),
    }
}

fn select_browser_path(
    browsers: &[BrowserDescriptor],
    browser_executable_path: Option<&Path>,
) -> Result<PathBuf, String> {
    if let Some(path) = browser_executable_path {
        if path.as_os_str().is_empty() {
            return Err("Browser executable path cannot be empty".to_string());
        }
        if !path.is_file() {
            return Err(format!(
                "Browser executable path is not a file: {}",
                path.display()
            ));
        }
        return Ok(path.to_path_buf());
    }

    browsers
        .first()
        .map(|browser| browser.path.clone())
        .ok_or_else(|| "No installed Chrome, Edge, or Chromium browser was found".to_string())
}

fn wait_for_devtools_active_port(profile_dir: &Path) -> Result<BrowserEndpoint, String> {
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut last_error = None;
    while Instant::now() < deadline {
        match read_devtools_active_port(profile_dir) {
            Ok(endpoint) => return Ok(endpoint),
            Err(error) => {
                last_error = Some(error);
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
    Err(last_error.unwrap_or_else(|| "Browser did not publish DevToolsActivePort".to_string()))
}

fn read_devtools_active_port(profile_dir: &Path) -> Result<BrowserEndpoint, String> {
    let path = profile_dir.join("DevToolsActivePort");
    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read DevToolsActivePort: {error}"))?;
    let port_line = contents
        .lines()
        .next()
        .ok_or_else(|| "DevToolsActivePort did not contain a port".to_string())?;
    let port = port_line
        .parse::<u16>()
        .map_err(|error| format!("DevToolsActivePort contained an invalid port: {error}"))?;
    Ok(BrowserEndpoint {
        host: "127.0.0.1".to_string(),
        port,
    })
}

fn candidate_browser_paths() -> Vec<(&'static str, &'static str, PathBuf)> {
    let mut paths = Vec::new();

    #[cfg(windows)]
    {
        for root_var in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
            if let Some(root) = env::var_os(root_var) {
                let root = PathBuf::from(root);
                paths.push((
                    "chrome",
                    "Google Chrome",
                    root.join("Google\\Chrome\\Application\\chrome.exe"),
                ));
                paths.push((
                    "edge",
                    "Microsoft Edge",
                    root.join("Microsoft\\Edge\\Application\\msedge.exe"),
                ));
            }
        }
        paths.extend(windows_registry_browser_paths());
    }

    #[cfg(target_os = "macos")]
    {
        paths.extend(macos_application_browser_paths(None));
    }

    #[cfg(target_os = "linux")]
    {
        for path in [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
        ] {
            paths.push(("chrome", "Google Chrome", PathBuf::from(path)));
        }
        paths.push((
            "edge",
            "Microsoft Edge",
            PathBuf::from("/usr/bin/microsoft-edge"),
        ));
        paths.push((
            "edge",
            "Microsoft Edge",
            PathBuf::from("/usr/bin/microsoft-edge-stable"),
        ));
        paths.extend(linux_path_browser_paths(env::var_os("PATH")));
    }

    dedupe_browser_candidates(paths)
}

fn dedupe_browser_candidates(
    candidates: Vec<(&'static str, &'static str, PathBuf)>,
) -> Vec<(&'static str, &'static str, PathBuf)> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::new();
    for (id, name, path) in candidates {
        let key = path.to_string_lossy().to_lowercase();
        if seen.insert(key) {
            deduped.push((id, name, path));
        }
    }
    deduped
}

#[cfg(target_os = "macos")]
fn macos_application_browser_paths(
    home_dir: Option<PathBuf>,
) -> Vec<(&'static str, &'static str, PathBuf)> {
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = home_dir.or_else(home_dir_from_env) {
        roots.push(home.join("Applications"));
    }

    let mut paths = Vec::new();
    for root in roots {
        paths.push((
            "chrome",
            "Google Chrome",
            root.join("Google Chrome.app/Contents/MacOS/Google Chrome"),
        ));
        paths.push((
            "edge",
            "Microsoft Edge",
            root.join("Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
        ));
    }
    paths
}

#[cfg(target_os = "macos")]
fn home_dir_from_env() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from)
}

#[cfg(target_os = "linux")]
fn linux_path_browser_paths(
    path_env: Option<OsString>,
) -> Vec<(&'static str, &'static str, PathBuf)> {
    let Some(path_env) = path_env else {
        return Vec::new();
    };

    let commands = [
        ("chrome", "Google Chrome", "google-chrome"),
        ("chrome", "Google Chrome", "google-chrome-stable"),
        ("chrome", "Chromium", "chromium"),
        ("chrome", "Chromium", "chromium-browser"),
        ("edge", "Microsoft Edge", "microsoft-edge"),
        ("edge", "Microsoft Edge", "microsoft-edge-stable"),
    ];

    let mut paths = Vec::new();
    for dir in env::split_paths(&path_env) {
        for (id, name, executable) in commands {
            paths.push((id, name, dir.join(executable)));
        }
    }
    paths
}

#[cfg(windows)]
fn windows_registry_browser_paths() -> Vec<(&'static str, &'static str, PathBuf)> {
    const APP_PATHS: [(&str, &'static str, &'static str); 2] = [
        ("chrome.exe", "chrome", "Google Chrome"),
        ("msedge.exe", "edge", "Microsoft Edge"),
    ];

    fn query_default_string(key: &str) -> Option<PathBuf> {
        let output = Command::new("reg")
            .args(["query", key, "/ve"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            if let Some((_, value)) = line.split_once("REG_SZ") {
                let path = value.trim();
                if !path.is_empty() {
                    return Some(PathBuf::from(path));
                }
            }
        }
        None
    }

    let mut paths = Vec::new();
    for root in ["HKCU", "HKLM"] {
        for (exe, id, name) in APP_PATHS {
            let subkeys = [
                format!("{root}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{exe}"),
                format!(
                    "{root}\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{exe}"
                ),
            ];
            for subkey in subkeys {
                if let Some(path) = query_default_string(&subkey) {
                    paths.push((id, name, path));
                }
            }
        }
    }
    paths
}

#[cfg(windows)]
fn kill_process_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(windows))]
fn kill_process_tree(pid: u32) {
    let pid = pid.to_string();
    let process_group = format!("-{pid}");
    let _ = Command::new("kill")
        .args(["-TERM", &process_group])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = Command::new("kill")
        .args(["-KILL", &process_group])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(windows)]
fn configure_child_group(_command: &mut Command) {}

#[cfg(unix)]
fn configure_child_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    command.process_group(0);
}

#[cfg(test)]
mod tests {
    use std::{ffi::OsStr, fs};

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn appends_headless_flag_when_requested() {
        let mut command = Command::new("browser");
        append_headless_args(
            &mut command,
            &BrowserStartRequest {
                headless: Some(true),
                ..Default::default()
            },
        );

        assert!(command
            .get_args()
            .any(|arg| arg == OsStr::new("--headless=new")));
    }

    #[test]
    fn does_not_append_headless_flag_by_default() {
        let mut command = Command::new("browser");
        append_headless_args(&mut command, &BrowserStartRequest::default());

        assert!(!command
            .get_args()
            .any(|arg| arg == OsStr::new("--headless=new")));
    }

    #[test]
    fn explicit_browser_executable_path_wins() {
        let temp = TempDir::new().expect("temp dir");
        let executable = temp.path().join("browser.exe");
        fs::write(&executable, "").expect("browser executable");

        let selected = select_browser_path(&[], Some(executable.as_path())).expect("selected path");

        assert_eq!(selected, executable);
    }

    #[test]
    fn auto_selects_first_discovered_browser() {
        let path = PathBuf::from("/opt/browser/chrome");
        let selected = select_browser_path(
            &[BrowserDescriptor {
                id: "chrome".to_string(),
                name: "Google Chrome".to_string(),
                path: path.clone(),
            }],
            None,
        )
        .expect("selected path");

        assert_eq!(selected, path);
    }

    #[test]
    fn reads_devtools_active_port_from_owned_profile() {
        let profile = TempDir::new().expect("temp profile");
        fs::write(
            profile.path().join("DevToolsActivePort"),
            "54321\n/devtools/browser/test\n",
        )
        .expect("write DevToolsActivePort");

        let endpoint = read_devtools_active_port(profile.path()).expect("endpoint");

        assert_eq!(endpoint.host, "127.0.0.1");
        assert_eq!(endpoint.port, 54321);
    }

    #[test]
    fn rejects_invalid_devtools_active_port_content() {
        let profile = TempDir::new().expect("temp profile");
        fs::write(profile.path().join("DevToolsActivePort"), "not-a-port\n")
            .expect("write DevToolsActivePort");

        assert!(read_devtools_active_port(profile.path()).is_err());
    }

    #[test]
    fn default_managed_profile_dir_uses_browser_data_directory_under_app_data() {
        let app_data_dir = TempDir::new().expect("app data dir");

        let expected = app_data_dir.path().join("browser-data");
        let profile =
            create_managed_profile_dir_with_default_path(None, &expected).expect("profile dir");

        assert!(expected.is_dir());
        assert_eq!(profile.path(), expected.as_path());
    }

    #[test]
    fn managed_profile_dir_clears_stale_devtools_active_port_before_launch() {
        let app_data_dir = TempDir::new().expect("app data dir");
        let profile_dir = app_data_dir.path().join("browser-data");
        fs::create_dir_all(&profile_dir).expect("profile dir");
        fs::write(
            profile_dir.join("DevToolsActivePort"),
            "54321\n/devtools/browser/stale\n",
        )
        .expect("stale DevToolsActivePort");

        let profile =
            create_managed_profile_dir_with_default_path(None, &profile_dir).expect("profile dir");

        assert_eq!(profile.path(), profile_dir.as_path());
        assert!(!profile_dir.join("DevToolsActivePort").exists());
    }
}
