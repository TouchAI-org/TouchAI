// Fixture: Rust command registry for the IPC presence gate.
// A fake marker in a comment must not win: tauri::generate_handler![fake_before_real];
/* A fake block marker and bracket ] must not close the real handler. */
const FAKE_MARKER_TEXT: &str = "tauri::generate_handler![fake_in_string]";
pub fn invoke_handler() {
    let _ = tauri::generate_handler![
        alpha::known_cmd,
        // alpha::ghost_cmd,
        /* alpha::block_ghost_cmd, */
        // A comment bracket ] does not close the handler.
        alpha::other_cmd,
        alpha::ns_known_cmd,
        bare_cmd,
    ];
}
