use super::*;

async fn fixture() -> (tempfile::TempDir, DatabaseRuntime, DriverStorage) {
    let temporary = tempfile::tempdir().expect("fixture");
    let database = DatabaseRuntime::initialize_for_tests(temporary.path())
        .await
        .expect("database");
    let storage = DriverStorage::new(
        database.clone(),
        temporary.path().join("computer-use"),
        temporary.path().join("assets/bin"),
    );
    (temporary, database, storage)
}

fn seed(root: &Path, driver: &str) -> PathBuf {
    let path = root.join(driver).join("1.2.0").join("driver.bin");
    std::fs::create_dir_all(path.parent().expect("parent")).expect("directory");
    std::fs::write(&path, b"verified driver bytes").expect("binary");
    path
}

#[tokio::test]
async fn user_given_no_custom_location_when_opening_then_keeps_drivers_beside_bundled_tools() {
    let (temporary, _, storage) = fixture().await;
    assert_eq!(
        *storage.read().await.expect("default location"),
        temporary.path().join("assets/bin/computer-use-drivers")
    );
    assert_eq!(
        storage.location().await.expect("displayed location"),
        PathBuf::new()
    );
    assert_eq!(
        storage.setting(DIRECTORY_KEY).await.expect("preference"),
        None
    );
}

#[tokio::test]
async fn user_given_a_saved_default_location_when_opening_then_removes_it_and_resolves_the_current_app_directory(
) {
    let (temporary, database, storage) = fixture().await;
    let default = temporary.path().join("assets/bin/computer-use-drivers");
    sqlx::query("INSERT INTO settings (key, value) VALUES (?, ?)")
        .bind(DIRECTORY_KEY)
        .bind(default.to_string_lossy().as_ref())
        .execute(database.pool())
        .await
        .expect("old default");
    assert!(storage
        .location()
        .await
        .expect("display")
        .as_os_str()
        .is_empty());
    assert_eq!(
        storage.setting(DIRECTORY_KEY).await.expect("preference"),
        None
    );
    let next_base = temporary.path().join("relocated-app/assets/bin");
    let reopened = DriverStorage::new(
        database,
        temporary.path().join("computer-use"),
        next_base.clone(),
    );
    assert_eq!(
        *reopened.read().await.expect("new default"),
        next_base.join(DIRECTORY_NAME)
    );
}

#[tokio::test]
async fn user_given_custom_drivers_when_clearing_the_location_then_preserves_files_and_removes_the_preference(
) {
    let (temporary, database, storage) = fixture().await;
    let original = storage.read().await.expect("default").clone();
    seed(&original, "cua-driver");
    seed(&original, "agent-desktop");
    let custom = temporary.path().join("custom");
    storage
        .relocate(custom.clone())
        .await
        .expect("custom location");
    assert!(storage
        .relocate(PathBuf::new())
        .await
        .expect("reset")
        .as_os_str()
        .is_empty());
    assert_eq!(
        storage.setting(DIRECTORY_KEY).await.expect("preference"),
        None
    );
    for driver in DRIVERS {
        assert_eq!(
            std::fs::read(original.join(driver).join("1.2.0/driver.bin")).expect("driver"),
            b"verified driver bytes"
        );
        assert!(!custom.join(DIRECTORY_NAME).join(driver).exists());
    }
    let reopened = DriverStorage::new(
        database,
        temporary.path().join("computer-use"),
        temporary.path().join("assets/bin"),
    );
    assert!(reopened
        .location()
        .await
        .expect("display")
        .as_os_str()
        .is_empty());
    assert_eq!(
        *reopened.read().await.expect("default after restart"),
        original
    );
}

#[tokio::test]
async fn user_given_a_failed_preference_delete_when_restoring_default_then_keeps_custom_drivers_and_location(
) {
    let (temporary, database, storage) = fixture().await;
    let original = storage.read().await.expect("default").clone();
    seed(&original, "cua-driver");
    let custom = temporary.path().join("custom");
    storage
        .relocate(custom.clone())
        .await
        .expect("custom location");
    sqlx::query(
        "CREATE TRIGGER reject_driver_reset
         BEFORE DELETE ON settings
         WHEN OLD.key = 'computer_use.driver_directory'
         BEGIN SELECT RAISE(FAIL, 'test reset failure'); END",
    )
    .execute(database.pool())
    .await
    .expect("reject reset");
    assert!(storage.relocate(PathBuf::new()).await.is_err());
    assert_eq!(storage.location().await.expect("location"), custom);
    assert!(custom
        .join(DIRECTORY_NAME)
        .join("cua-driver/1.2.0/driver.bin")
        .exists());
    assert!(!original.join("cua-driver").exists());
}

#[tokio::test]
async fn user_given_a_parent_folder_when_selecting_it_then_nests_driver_versions_without_touching_other_tools(
) {
    let (temporary, _, storage) = fixture().await;
    let original = storage.read().await.expect("original").clone();
    seed(&original, "cua-driver");
    let parent = temporary.path().join("tools");
    std::fs::create_dir_all(&parent).expect("tools");
    std::fs::write(parent.join("rtk.exe"), b"other tool").expect("rtk");
    assert_eq!(
        storage.relocate(parent.clone()).await.expect("move"),
        parent
    );
    let root = parent.join("computer-use-drivers");
    assert_eq!(*storage.read().await.expect("root"), root);
    assert!(root.join("cua-driver/1.2.0/driver.bin").exists());
    assert_eq!(
        std::fs::read(parent.join("rtk.exe")).expect("rtk"),
        b"other tool"
    );
    assert!(!parent.join("cua-driver").exists());
}

#[tokio::test]
async fn user_given_previous_default_installations_when_opening_then_reuses_both_drivers_in_the_shared_binary_directory(
) {
    let (temporary, _, storage) = fixture().await;
    let previous = temporary.path().join("computer-use-drivers");
    seed(&previous, "cua-driver");
    seed(&previous, "agent-desktop");
    std::fs::write(previous.join("keep.txt"), "unrelated").expect("unrelated");
    let root = storage.read().await.expect("migrate");
    for driver in DRIVERS {
        assert!(root.join(driver).join("1.2.0/driver.bin").exists());
        assert!(!previous.join(driver).exists());
    }
    assert_eq!(
        *root,
        temporary.path().join("assets/bin/computer-use-drivers")
    );
    assert!(previous.join("keep.txt").exists());
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
            std::fs::read(
                destination
                    .join(DIRECTORY_NAME)
                    .join(driver)
                    .join("1.2.0/driver.bin")
            )
            .expect("copied"),
            b"verified driver bytes"
        );
        assert!(!original.join(driver).exists());
    }
    assert_eq!(
        std::fs::read_to_string(destination.join("unrelated.txt")).expect("unrelated"),
        "keep"
    );
    let reopened = DriverStorage::new(
        database,
        temporary.path().join("computer-use"),
        temporary.path().join("assets/bin"),
    );
    assert_eq!(
        *reopened.read().await.expect("reopen"),
        destination.join(DIRECTORY_NAME)
    );
    assert_eq!(
        reopened.location().await.expect("displayed location"),
        destination
    );
}

#[tokio::test]
async fn user_given_an_occupied_or_nested_destination_when_relocating_then_preserves_original_files_and_setting(
) {
    let (temporary, _, storage) = fixture().await;
    let original = storage.read().await.expect("root").clone();
    let binary = seed(&original, "cua-driver");
    let occupied = temporary.path().join("occupied");
    seed(&occupied.join(DIRECTORY_NAME), "agent-desktop");
    for target in [occupied, original.join("nested"), PathBuf::from("relative")] {
        assert!(storage.relocate(target).await.is_err());
        assert_eq!(*storage.read().await.expect("root"), original);
        assert_eq!(
            std::fs::read(&binary).expect("original binary"),
            b"verified driver bytes"
        );
    }
}

#[tokio::test]
async fn user_given_a_nested_destination_when_relocating_then_leaves_the_current_root_untouched() {
    let (_temporary, _, storage) = fixture().await;
    let original = storage.read().await.expect("root").clone();
    seed(&original, "cua-driver");
    let nested = original.join("nested");
    assert!(storage.relocate(nested.clone()).await.is_err());
    assert!(!nested.exists());
    assert_eq!(*storage.read().await.expect("root"), original);
}

#[tokio::test]
async fn user_given_a_legacy_install_and_an_empty_target_folder_when_opening_then_moves_the_driver_instead_of_leaving_it_behind(
) {
    let (temporary, _, storage) = fixture().await;
    seed(temporary.path(), "computer-use");
    let default = temporary.path().join("assets/bin/computer-use-drivers");
    std::fs::create_dir_all(default.join("cua-driver")).expect("empty target");
    let root = storage.read().await.expect("migrate");
    assert_eq!(*root, default);
    assert!(root.join("cua-driver/1.2.0/driver.bin").is_file());
    assert!(!temporary.path().join("computer-use/1.2.0").exists());
}

#[tokio::test]
async fn user_given_a_legacy_cua_install_when_opening_then_migrates_without_redownloading_or_changing_agent_desktop(
) {
    let (temporary, _, storage) = fixture().await;
    let legacy = temporary.path().join("computer-use");
    seed(temporary.path(), "computer-use");
    let default = temporary.path().join("assets/bin/computer-use-drivers");
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
    sqlx::query(
        "CREATE TRIGGER reject_driver_location
         BEFORE INSERT ON settings
         WHEN NEW.key = 'computer_use.driver_directory'
         BEGIN SELECT RAISE(FAIL, 'test storage failure'); END",
    )
    .execute(database.pool())
    .await
    .expect("reject writes");
    let destination = temporary.path().join("destination");
    assert!(storage.relocate(destination.clone()).await.is_err());
    assert!(binary.exists());
    assert!(!destination.join(DIRECTORY_NAME).join("cua-driver").exists());
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

#[tokio::test]
async fn user_given_an_existing_custom_installation_when_opening_then_preserves_its_location_and_files(
) {
    let (temporary, _, storage) = fixture().await;
    let custom = temporary.path().join("custom-tools");
    let binary = seed(&custom, "cua-driver");
    storage
        .persist(&custom, &[])
        .await
        .expect("previous preference");
    assert_eq!(storage.location().await.expect("display"), custom);
    assert_eq!(*storage.read().await.expect("root"), custom);
    assert_eq!(
        std::fs::read(binary).expect("binary"),
        b"verified driver bytes"
    );
}

#[tokio::test]
async fn user_given_the_managed_subdirectory_when_selecting_it_again_then_keeps_a_single_suffix_and_the_installed_driver(
) {
    let (_temporary, _, storage) = fixture().await;
    let root = storage.read().await.expect("root").clone();
    let binary = seed(&root, "cua-driver");
    let parent = root.parent().expect("parent");
    assert_eq!(
        storage.relocate(root.clone()).await.expect("same root"),
        PathBuf::new()
    );
    assert_eq!(
        storage
            .relocate(parent.to_path_buf())
            .await
            .expect("same parent"),
        PathBuf::new()
    );
    assert_eq!(*storage.read().await.expect("root"), root);
    assert!(binary.exists());
    assert!(!root.join(DIRECTORY_NAME).exists());
}
