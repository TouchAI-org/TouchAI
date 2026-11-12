use std::sync::LazyLock;

use super::super::manifest::{load, Artifact, Manifest};

pub static MANIFEST: LazyLock<Manifest<'static>> = LazyLock::new(|| load("cua-driver"));

pub fn release_filename(artifact: &Artifact<'_>, version: &str) -> Result<String, String> {
    let name = artifact
        .package_path
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .ok_or("the driver manifest has no package name")?;
    let pinned = MANIFEST.version;
    if !name.contains(pinned) {
        return Err("the driver manifest package name has no version".into());
    }
    Ok(name.replace(pinned, version))
}

#[cfg(test)]
mod tests {
    use super::super::super::manifest::artifact_for;
    use super::*;

    #[test]
    fn user_given_an_unsupported_cua_target_when_installing_then_is_not_offered_an_incomplete_download(
    ) {
        assert!(artifact_for(&MANIFEST, "aarch64-pc-windows-msvc").is_none());
        assert!(artifact_for(&MANIFEST, "sparc-unknown-none").is_none());
    }

    #[test]
    fn user_given_a_newer_version_when_resolving_its_archive_then_gets_the_published_wheel_name() {
        let artifact = artifact_for(&MANIFEST, "x86_64-pc-windows-msvc").expect("artifact");
        assert_eq!(
            release_filename(artifact, "0.44.0").as_deref(),
            Ok("cua_driver-0.44.0-py3-none-win_amd64.whl")
        );
    }
}
