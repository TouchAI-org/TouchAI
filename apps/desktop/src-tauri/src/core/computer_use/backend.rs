use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{agent_desktop, cua_driver, http::HttpWheelFetcher, manifest};

#[derive(Clone, Debug, Serialize)]
pub struct DriverStatus {
    pub installed: bool,
    pub binary: Option<String>,
    pub driver_version: Option<String>,
    pub installed_size_bytes: Option<u64>,
    pub abi_version: Option<String>,
    pub metadata: Option<Value>,
    pub error: Option<String>,
}

impl DriverStatus {
    pub(super) fn missing(error: Option<String>) -> Self {
        Self {
            installed: false,
            binary: None,
            driver_version: None,
            installed_size_bytes: None,
            abi_version: None,
            metadata: None,
            error,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: Option<String>,
    pub update_available: bool,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Default, Deserialize, Debug, PartialEq, Eq)]
pub enum DriverId {
    #[default]
    #[serde(rename = "cua-driver")]
    Cua,
    #[serde(rename = "agent-desktop")]
    AgentDesktop,
}

impl DriverId {
    pub fn name(self) -> &'static str {
        match self {
            Self::Cua => "cua-driver",
            Self::AgentDesktop => "agent-desktop",
        }
    }

    pub fn root(self, directory: &Path) -> PathBuf {
        directory.join(self.name())
    }

    pub async fn status(self, root: PathBuf) -> Result<DriverStatus, String> {
        match self {
            Self::Cua => cua_driver::installed_status(self.root(&root)).await,
            Self::AgentDesktop => {
                let root = self.root(&root);
                let status = agent_desktop::status(&root)?;
                if status.installed {
                    agent_desktop::list_tools(root).await?;
                }
                Ok(status)
            }
        }
    }

    pub async fn prepare(
        self,
        root: PathBuf,
        fetcher: &HttpWheelFetcher,
    ) -> Result<DriverStatus, String> {
        match self {
            Self::Cua => {
                cua_driver::ensure_ready(self.root(&root), fetcher, manifest::current_target())
                    .await
            }
            Self::AgentDesktop => agent_desktop::prepare(self.root(&root), fetcher).await,
        }
    }

    pub async fn list_tools(self, root: PathBuf) -> Result<Vec<Value>, String> {
        match self {
            Self::Cua => {
                cua_driver::restore_installed(self.root(&root)).await?;
                tauri::async_runtime::spawn_blocking(cua_driver::list_tools)
                    .await
                    .map_err(|error| error.to_string())?
            }
            Self::AgentDesktop => agent_desktop::list_tools(self.root(&root)).await,
        }
    }

    pub async fn remove(self, root: &Path) -> Result<(), String> {
        match self {
            Self::Cua => cua_driver::remove_installed(&self.root(root)).await,
            Self::AgentDesktop => agent_desktop::remove(&self.root(root)).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::cua_driver::manifest::MANIFEST;
    use super::*;

    #[tokio::test]
    async fn user_given_missing_drivers_when_checking_them_then_sees_no_size_without_installing() {
        let directory = tempfile::tempdir().expect("isolated directory");
        for driver in [DriverId::Cua, DriverId::AgentDesktop] {
            let status = driver
                .status(directory.path().to_path_buf())
                .await
                .expect("status");
            let payload = serde_json::to_value(status).expect("status payload");
            assert!(!payload["installed"].as_bool().expect("installed flag"));
            assert!(payload["installed_size_bytes"].is_null());
            assert_eq!(
                std::fs::read_dir(directory.path())
                    .expect("unchanged directory")
                    .count(),
                0
            );
        }
    }

    #[tokio::test]
    async fn user_given_an_installed_driver_when_checking_then_sees_actual_version_files_without_unrelated_cache(
    ) {
        let directory = tempfile::tempdir().expect("isolated directory");
        let artifact = manifest::artifact(&MANIFEST).expect("supported platform");
        let root = DriverId::Cua.root(directory.path());
        let version = root.join(MANIFEST.version);
        std::fs::create_dir_all(&version).expect("version directory");
        let binary = version.join(Path::new(artifact.entry).file_name().expect("binary name"));
        std::fs::write(&binary, b"driver fixture").expect("binary");
        std::fs::write(version.join("helper"), b"helper fixture").expect("helper");
        let record = serde_json::json!({
            "version": MANIFEST.version,
            "wheel_sha256": artifact.sha256,
            "binary_sha256": super::super::provision::sha256_file(&binary).expect("hash"),
        })
        .to_string();
        std::fs::write(version.join("install.json"), &record).expect("install record");
        std::fs::write(root.join("unrelated-cache"), [0u8; 4096]).expect("cache");
        let status = DriverId::Cua
            .status(directory.path().to_path_buf())
            .await
            .expect("installed status");
        let payload = serde_json::to_value(status).expect("status payload");
        assert_eq!(payload["installed"], true);
        assert_eq!(
            payload["installed_size_bytes"].as_u64(),
            Some((28 + record.len()) as u64)
        );
    }

    #[test]
    fn user_given_two_drivers_when_removing_either_then_its_directory_cannot_contain_the_other() {
        let legacy = Path::new("/profile/computer-use");
        let cua = DriverId::Cua.root(legacy);
        let agent = DriverId::AgentDesktop.root(legacy);
        assert!(!agent.starts_with(&cua));
        assert!(!cua.starts_with(&agent));
        assert_eq!(cua, legacy.join("cua-driver"));
    }

    #[tokio::test]
    async fn user_given_two_installed_drivers_when_removing_either_then_preserves_its_peer_and_recordings(
    ) {
        for removed in [DriverId::Cua, DriverId::AgentDesktop] {
            let directory = tempfile::tempdir().expect("isolated installations");
            for driver in [DriverId::Cua, DriverId::AgentDesktop] {
                let version = driver.root(directory.path()).join("1.2.0");
                std::fs::create_dir_all(&version).expect("version directory");
                std::fs::write(version.join("driver.bin"), driver.name()).expect("driver file");
            }
            let recording = directory.path().join("recording.json");
            std::fs::write(&recording, "saved recording").expect("recording");
            removed
                .remove(directory.path())
                .await
                .expect("remove driver");
            assert!(!removed.root(directory.path()).exists());
            let remaining = match removed {
                DriverId::Cua => DriverId::AgentDesktop,
                DriverId::AgentDesktop => DriverId::Cua,
            };
            assert_eq!(
                std::fs::read_to_string(remaining.root(directory.path()).join("1.2.0/driver.bin"))
                    .expect("peer remains installed"),
                remaining.name()
            );
            assert_eq!(
                std::fs::read_to_string(recording).expect("preserved recording"),
                "saved recording"
            );
        }
    }

    #[test]
    fn user_given_an_unknown_driver_when_requesting_control_then_is_refused() {
        assert!(serde_json::from_str::<DriverId>("\"other\"").is_err());
    }
}
