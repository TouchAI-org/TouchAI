use std::collections::BTreeMap;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct Artifact<'source> {
    pub target: &'source str,
    pub package_path: &'source str,
    pub sha256: &'source str,
    pub size: u64,
    pub entry: &'source str,
    pub transport: Transport,
    #[serde(default)]
    pub binary_sha256: &'source str,
    #[serde(default)]
    pub filename: &'source str,
    #[serde(default, borrow)]
    pub helpers: Vec<Helper<'source>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Helper<'source> {
    pub entry: &'source str,
    pub filename: &'source str,
    pub sha256: &'source str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Transport {
    InProcess,
    Stdio,
}

#[derive(Debug, Deserialize)]
pub struct Manifest<'source> {
    pub version: &'source str,
    #[serde(default, borrow)]
    pub artifacts: Vec<Artifact<'source>>,
    #[serde(default, borrow)]
    pub mirrors: Vec<&'source str>,
}

pub const RESOURCES: &str = include_str!("../../../resources/binaries.json");

pub fn load(name: &str) -> Manifest<'static> {
    let mut resources: BTreeMap<&str, Manifest<'static>> =
        serde_json::from_str(RESOURCES).expect("embedded resource manifest is valid");
    resources.remove(name).expect("embedded resource exists")
}

pub fn current_target() -> &'static str {
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        "aarch64-pc-windows-msvc"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "x86_64-unknown-linux-gnu"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "aarch64-unknown-linux-gnu"
    } else {
        "unsupported"
    }
}

pub fn artifact_for<'manifest>(
    manifest: &'manifest Manifest<'static>,
    target: &str,
) -> Option<&'manifest Artifact<'static>> {
    manifest.artifacts.iter().find(|item| item.target == target)
}

pub fn artifact<'manifest>(
    manifest: &'manifest Manifest<'static>,
) -> Option<&'manifest Artifact<'static>> {
    artifact_for(manifest, current_target())
}

pub fn is_publishable(artifact: &Artifact<'_>) -> bool {
    artifact.size > 0
        && artifact.sha256.len() == 64
        && !artifact.package_path.contains("PLACEHOLDER")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_given_supported_drivers_when_resolving_releases_then_gets_verified_artifacts_from_one_manifest(
    ) {
        for name in ["cua-driver", "agent-desktop"] {
            let manifest = load(name);
            assert!(semver::Version::parse(manifest.version).is_ok());
            assert!(manifest.mirrors.len() >= 2);
            for item in &manifest.artifacts {
                assert!(is_publishable(item));
                assert_eq!(
                    artifact_for(&manifest, item.target).map(|entry| entry.sha256),
                    Some(item.sha256)
                );
                assert!(item.package_path.contains(manifest.version));
                assert!(item.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()));
                for helper in &item.helpers {
                    assert_eq!(helper.sha256.len(), 64);
                    assert!(!helper.filename.contains('/'));
                }
            }
        }
    }

    #[test]
    fn user_given_linux_or_macos_agent_desktop_when_installing_then_receives_its_required_helper() {
        let manifest = load("agent-desktop");
        for item in &manifest.artifacts {
            assert!(!item.binary_sha256.is_empty());
            if !item.target.contains("windows") {
                assert_eq!(item.helpers.len(), 1);
            }
        }
    }
}
