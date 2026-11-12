use std::path::{Path, PathBuf};

pub(super) fn create_recording_directory(root: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(root)
        .map_err(|error| format!("failed to create {}: {error}", root.display()))?;
    let directory = root.join(format!("recording-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory)
        .map_err(|error| format!("failed to create {}: {error}", directory.display()))?;
    Ok(directory)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_given_previous_recordings_when_starting_again_then_keeps_each_run_separate() {
        let root = tempfile::tempdir().expect("recording root");
        let first = create_recording_directory(root.path()).expect("first recording");
        std::fs::write(first.join("action.json"), "previous action").expect("previous action");
        let second = create_recording_directory(root.path()).expect("second recording");
        assert_ne!(first, second);
        assert_eq!(second.parent(), Some(root.path()));
        assert_eq!(
            std::fs::read_to_string(first.join("action.json")).expect("preserved action"),
            "previous action"
        );
        assert_eq!(std::fs::read_dir(second).expect("new recording").count(), 0);
    }

    #[test]
    fn user_given_a_file_as_recording_location_when_starting_then_gets_an_error_without_changing_it(
    ) {
        let root = tempfile::tempdir().expect("recording root");
        let file = root.path().join("existing.txt");
        std::fs::write(&file, "keep").expect("existing file");
        assert!(create_recording_directory(&file).is_err());
        assert_eq!(
            std::fs::read_to_string(file).expect("preserved file"),
            "keep"
        );
    }
}
