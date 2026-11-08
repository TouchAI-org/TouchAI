use super::*;

async fn fixture() -> (tempfile::TempDir, DatabaseRuntime, DriverStorage) {
    let temporary = tempfile::tempdir().expect("fixture");
    let database = DatabaseRuntime::initialize_for_tests(temporary.path())
        .await
        .expect("database");
    let storage = DriverStorage::new(database.clone(), temporary.path().join("computer-use"));
    (temporary, database, storage)
}

fn seed(root: &Path, driver: &str) -> PathBuf {
    let path = root.join(driver).join("1.2.0").join("driver.bin");
    std::fs::create_dir_all(path.parent().expect("parent")).expect("directory");
    std::fs::write(&path, b"verified driver bytes").expect("binary");
    path
}

#[tokio::test]
async fn user_given_two_drivers_when_relocating_then_preserves_versions_and_remembers_the_new_root()
{
    let (temporary, database, storage) = fixture().await;
    let original = storage.read().await.expect("root").clone();
    seed(&original, "cua-driver");
    seed(&original, "agent-desktop");
    let destination = temporary.path().join("用户驱动");
    std::fs::create_dir_all(&destination).expect("destination");
    std::fs::write(destination.join("unrelated.txt"), "keep").expect("unrelated");
    storage
        .relocate(destination.clone())
        .await
        .expect("relocate");
    for driver in ["cua-driver", "agent-desktop"] {
        assert_eq!(
            std::fs::read(destination.join(driver).join("1.2.0/driver.bin")).expect("copied"),
            b"verified driver bytes"
        );
        assert!(!original.join(driver).exists());
    }
    assert_eq!(
        std::fs::read_to_string(destination.join("unrelated.txt")).expect("unrelated"),
        "keep"
    );
    let reopened = DriverStorage::new(database, temporary.path().join("computer-use"));
    assert_eq!(*reopened.read().await.expect("reopen"), destination);
}

#[tokio::test]
async fn user_given_an_occupied_or_nested_destination_when_relocating_then_preserves_original_files_and_setting(
) {
    let (temporary, _, storage) = fixture().await;
    let original = storage.read().await.expect("root").clone();
    let binary = seed(&original, "cua-driver");
    let occupied = temporary.path().join("occupied");
    seed(&occupied, "agent-desktop");
    for target in [
        occupied,
        original.join("nested"),
        temporary.path().to_path_buf(),
    ] {
        assert!(storage.relocate(target).await.is_err());
        assert_eq!(*storage.read().await.expect("root"), original);
        assert_eq!(
            std::fs::read(&binary).expect("original binary"),
            b"verified driver bytes"
        );
    }
}

#[tokio::test]
async fn user_given_a_legacy_cua_install_when_opening_then_migrates_without_redownloading_or_changing_agent_desktop(
) {
    let (temporary, _, storage) = fixture().await;
    let legacy = temporary.path().join("computer-use");
    seed(temporary.path(), "computer-use");
    let default = temporary.path().join("computer-use-drivers");
    seed(&default, "agent-desktop");
    let root = storage.read().await.expect("migrate");
    assert_eq!(*root, default);
    assert!(root.join("cua-driver/1.2.0/driver.bin").is_file());
    assert!(root.join("agent-desktop/1.2.0/driver.bin").is_file());
    assert!(!legacy.join("1.2.0").exists());
}

#[tokio::test]
async fn user_given_a_busy_driver_when_relocating_then_waits_for_the_operation_to_release_storage()
{
    let (temporary, _, storage) = fixture().await;
    let lease = storage.read().await.expect("lease");
    let destination = temporary.path().join("destination");
    assert!(tokio::time::timeout(
        std::time::Duration::from_millis(50),
        storage.relocate(destination.clone())
    )
    .await
    .is_err());
    assert!(!destination.exists());
    drop(lease);
    storage
        .relocate(destination)
        .await
        .expect("move after release");
}

#[tokio::test]
async fn user_given_a_settings_write_failure_when_relocating_then_keeps_original_files_and_removes_the_copy(
) {
    let (temporary, database, storage) = fixture().await;
    let original = storage.read().await.expect("root").clone();
    let binary = seed(&original, "cua-driver");
    database.query(DatabaseQueryRequest {
        sql: "CREATE TRIGGER reject_driver_location BEFORE INSERT ON settings WHEN NEW.key = 'computer_use.driver_directory' BEGIN SELECT RAISE(FAIL, 'test storage failure'); END".into(),
        params: vec![],
        method: DatabaseQueryMethod::Run,
    }).await.expect("reject writes");
    let destination = temporary.path().join("destination");
    assert!(storage.relocate(destination.clone()).await.is_err());
    assert!(binary.exists());
    assert!(!destination.join("cua-driver").exists());
    assert_eq!(*storage.read().await.expect("unchanged root"), original);
}

#[tokio::test]
async fn user_given_a_missing_custom_location_when_selecting_a_new_directory_then_can_install_drivers_there(
) {
    let (temporary, _, storage) = fixture().await;
    let missing = temporary.path().join("missing");
    storage
        .persist(&missing, &[])
        .await
        .expect("saved external location");
    assert_eq!(*storage.read().await.expect("configured location"), missing);
    let destination = temporary.path().join("new");
    assert_eq!(
        storage
            .relocate(destination.clone())
            .await
            .expect("new location"),
        destination
    );
}
