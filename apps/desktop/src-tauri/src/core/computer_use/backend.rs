use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

use super::{agent_desktop, driver, http::HttpWheelFetcher, manifest};

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

    pub async fn status(self, root: PathBuf) -> Result<driver::DriverStatus, String> {
        match self {
            Self::Cua => driver::installed_status(self.root(&root)).await,
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
    ) -> Result<driver::DriverStatus, String> {
        match self {
            Self::Cua => {
                driver::ensure_ready(self.root(&root), fetcher, manifest::current_target()).await
            }
            Self::AgentDesktop => agent_desktop::prepare(self.root(&root), fetcher).await,
        }
    }

    pub async fn list_tools(self, root: PathBuf) -> Result<Vec<Value>, String> {
        match self {
            Self::Cua => {
                driver::restore_installed(self.root(&root)).await?;
                tauri::async_runtime::spawn_blocking(driver::list_tools)
                    .await
                    .map_err(|error| error.to_string())?
            }
            Self::AgentDesktop => agent_desktop::list_tools(self.root(&root)).await,
        }
    }

    pub async fn remove(self, root: &Path) -> Result<(), String> {
        match self {
            Self::Cua => driver::remove_installed(&self.root(root)).await,
            Self::AgentDesktop => agent_desktop::remove(&self.root(root)).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_given_two_drivers_when_removing_either_then_its_directory_cannot_contain_the_other() {
        let legacy = Path::new("/profile/computer-use");
        let cua = DriverId::Cua.root(legacy);
        let agent = DriverId::AgentDesktop.root(legacy);
        assert!(!agent.starts_with(&cua));
        assert!(!cua.starts_with(&agent));
        assert_eq!(cua, legacy.join("cua-driver"));
    }

    #[test]
    fn user_given_an_unknown_driver_when_requesting_control_then_is_refused() {
        assert!(serde_json::from_str::<DriverId>("\"other\"").is_err());
    }
}
