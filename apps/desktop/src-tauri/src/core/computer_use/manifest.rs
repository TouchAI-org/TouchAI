// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Pinned cua-driver release manifest and target mapping.
//!
//! One entry per supported platform. Windows and Linux extract only the shared
//! library and run it in-process; macOS ships a signed app bundle and is served
//! by the daemon, so its entry is declared but not loadable in-process.

pub struct Artifact {
    pub target: &'static str,
    pub package_path: &'static str,
    pub sha256: &'static str,
    pub size: u64,
    /// File to extract from the wheel.
    pub entry: &'static str,
    /// How this platform runs the engine.
    pub transport: Transport,
    pub binary_sha256: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    /// Loaded into the app process through the C ABI.
    InProcess,
}

pub struct Manifest {
    pub version: &'static str,
    pub artifacts: &'static [Artifact],
    pub mirrors: &'static [&'static str],
}

pub const MANIFEST: Manifest = Manifest {
    version: "0.38.0",
    artifacts: &[
        Artifact {
            target: "x86_64-pc-windows-msvc",
            package_path: "/packages/8c/1c/82b8cf495926bb49e298d3a77b03ab8948792eb7c6867af17e08078a7e32/cua_driver-0.38.0-py3-none-win_amd64.whl",
            sha256: "30e6fe57c70bbf5ed910268affce7e72c82a7d2469201c27432ad33d5487f258",
            size: 32_842_600,
            entry: "cua_driver/cua_driver_sdk.dll",
            transport: Transport::InProcess,
            binary_sha256: "",
        },
        Artifact {
            target: "aarch64-pc-windows-msvc",
            package_path: "/packages/PLACEHOLDER/cua_driver-0.38.0-py3-none-win_arm64.whl",
            sha256: "",
            size: 0,
            entry: "cua_driver/cua_driver_sdk.dll",
            transport: Transport::InProcess,
            binary_sha256: "",
        },
        Artifact {
            target: "x86_64-unknown-linux-gnu",
            package_path: "/packages/db/82/7594803d8794fd3d5a6d8d459174885b844276a525832e0532af14eaaebb/cua_driver-0.38.0-py3-none-manylinux_2_31_x86_64.whl",
            sha256: "9b8ef76b1cab76de2ea0804f77b5ccd6fe7403a2a26d0249fd3a7aa8acb0250a",
            size: 35_149_443,
            entry: "cua_driver/libcua_driver_sdk.so",
            transport: Transport::InProcess,
            binary_sha256: "",
        },
        Artifact {
            target: "aarch64-unknown-linux-gnu",
            package_path: "/packages/01/27/b06921ff828c41c9be25de3509f200033b3ba2fd558447d3e262b5329b25/cua_driver-0.38.0-py3-none-manylinux_2_31_aarch64.whl",
            sha256: "7f4162bdc4f62fe6482a7f5158892b2f0fc2f071f1d80f6fbc4989a351cb19fa",
            size: 35_219_850,
            entry: "cua_driver/libcua_driver_sdk.so",
            transport: Transport::InProcess,
            binary_sha256: "",
        },
        Artifact {
            target: "aarch64-apple-darwin",
            package_path: "/packages/e8/c4/fb3eec3668d32f80b079675fef95f14a6c681a318068a495fcf039d5e961/cua_driver-0.38.0-py3-none-macosx_13_0_universal2.whl",
            sha256: "ede29acd4bd168806257cebf30f047e87f99659a895567b9f2a651ddd0cabe10",
            size: 50_534_861,
            entry: "cua_driver/libcua_driver_sdk.dylib",
            transport: Transport::InProcess,
            binary_sha256: "",
        },
        Artifact {
            target: "x86_64-apple-darwin",
            package_path: "/packages/e8/c4/fb3eec3668d32f80b079675fef95f14a6c681a318068a495fcf039d5e961/cua_driver-0.38.0-py3-none-macosx_13_0_universal2.whl",
            sha256: "ede29acd4bd168806257cebf30f047e87f99659a895567b9f2a651ddd0cabe10",
            size: 50_534_861,
            entry: "cua_driver/libcua_driver_sdk.dylib",
            transport: Transport::InProcess,
            binary_sha256: "",
        },
    ],
    mirrors: &[
        "https://pypi.tuna.tsinghua.edu.cn",
        "https://mirrors.aliyun.com/pypi",
        "https://pypi.org",
    ],
};

/// Current build target in rustc triple form.
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

pub fn artifact_for(manifest: &'static Manifest, target: &str) -> Option<&'static Artifact> {
    manifest.artifacts.iter().find(|item| item.target == target)
}

pub fn artifact(manifest: &'static Manifest) -> Option<&'static Artifact> {
    artifact_for(manifest, current_target())
}

/// An artifact is loadable only when every field the downloader needs is set.
///
/// A declared-but-unfilled target reports as unsupported instead of failing a
/// download halfway through.
pub fn is_publishable(artifact: &Artifact) -> bool {
    artifact.size > 0
        && artifact.sha256.len() == 64
        && !artifact.package_path.contains("PLACEHOLDER")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_declared_target_resolves_to_its_own_entry() {
        assert!(!MANIFEST.artifacts.is_empty());
        for item in MANIFEST.artifacts {
            assert_eq!(
                artifact_for(&MANIFEST, item.target).map(|found| found.package_path),
                Some(item.package_path)
            );
        }
    }

    #[test]
    fn a_publishable_artifact_carries_a_full_digest_and_size() {
        for item in MANIFEST
            .artifacts
            .iter()
            .filter(|item| is_publishable(item))
        {
            assert_eq!(item.sha256.len(), 64, "{} digest length", item.target);
            assert!(
                item.sha256
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()),
                "{} digest charset",
                item.target
            );
            assert!(item.size > 0, "{} size", item.target);
            assert!(
                !item.package_path.contains("PLACEHOLDER"),
                "{} path",
                item.target
            );
        }
    }

    #[test]
    fn an_unfilled_target_is_not_offered_as_downloadable() {
        let pending = artifact_for(&MANIFEST, "aarch64-pc-windows-msvc").expect("declared target");

        assert!(!is_publishable(pending));
        assert!(is_publishable(
            artifact_for(&MANIFEST, "x86_64-pc-windows-msvc").expect("windows target")
        ));
    }

    #[test]
    fn in_process_targets_point_at_a_shared_library() {
        for item in MANIFEST.artifacts {
            assert_eq!(item.transport, Transport::InProcess, "{}", item.target);
            assert!(
                item.entry.ends_with(".dll")
                    || item.entry.ends_with(".so")
                    || item.entry.ends_with(".dylib"),
                "{} entry is {}",
                item.target,
                item.entry
            );
        }
    }

    #[test]
    fn both_linux_architectures_are_declared_and_publishable() {
        for target in ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"] {
            let item = artifact_for(&MANIFEST, target).expect("linux target");
            assert!(is_publishable(item), "{target} must be downloadable");
            assert_eq!(item.transport, Transport::InProcess);
        }
    }

    #[test]
    fn unknown_target_resolves_to_no_artifact() {
        assert!(artifact_for(&MANIFEST, "sparc-unknown-none").is_none());
    }
}
