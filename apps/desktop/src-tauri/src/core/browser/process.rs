use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use tempfile::TempDir;

use super::{
    endpoint::BrowserEndpoint,
    types::{BrowserDescriptor, BrowserStartRequest},
    url_policy::validate_browser_url,
};

#[derive(Debug)]
pub struct ManagedBrowserProcess {
    child: Child,
    profile_dir: Option<TempDir>,
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
        if let Some(profile_dir) = self.profile_dir.take() {
            remove_profile_dir_with_retry(profile_dir);
        }
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
    let browser_path = select_browser_path(&browsers, request.browser_id.as_deref())?;

    let user_data_dir = tempfile::Builder::new()
        .prefix(&format!("touchai-browser-{}-", std::process::id()))
        .tempdir_in(env::temp_dir())
        .map_err(|error| format!("Failed to create browser profile directory: {error}"))?;

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
        .arg("--window-size=1280,900")
        .arg(startup_url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
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

fn select_browser_path(
    browsers: &[BrowserDescriptor],
    browser_id: Option<&str>,
) -> Result<PathBuf, String> {
    match browser_id {
        Some(id) => browsers
            .iter()
            .find(|browser| browser.id == id)
            .map(|browser| browser.path.clone())
            .ok_or_else(|| format!("Supported browser '{id}' was not found")),
        None => browsers
            .first()
            .map(|browser| browser.path.clone())
            .ok_or_else(|| "No installed Chrome or Edge browser was found".to_string()),
    }
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

fn remove_profile_dir_with_retry(profile_dir: TempDir) {
    let path = profile_dir.path().to_path_buf();
    drop(profile_dir);
    let deadline = Instant::now() + Duration::from_secs(8);
    while path.exists() && Instant::now() < deadline {
        let _ = fs::remove_dir_all(&path);
        if !path.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
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
    }

    #[cfg(target_os = "macos")]
    {
        paths.push((
            "chrome",
            "Google Chrome",
            PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ));
        paths.push((
            "edge",
            "Microsoft Edge",
            PathBuf::from("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
        ));
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
    use std::fs;

    use tempfile::TempDir;

    use super::*;

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
}
