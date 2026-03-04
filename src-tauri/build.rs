fn main() {
    let mcp_cap_path = std::path::Path::new("capabilities/mcp-bridge.json");

    #[cfg(all(feature = "mcp-bridge", debug_assertions))]
    {
        let cap = r#"{
    "identifier": "mcp-bridge",
    "description": "enables MCP bridge for development",
    "windows": [
        "main"
    ],
    "permissions": [
        "mcp-bridge:default"
    ]
}"#;

        std::fs::write(mcp_cap_path, cap).expect("failed to write mcp-bridge capability");
    }

    #[cfg(not(all(feature = "mcp-bridge", debug_assertions)))]
    {
        let _ = std::fs::remove_file(mcp_cap_path);
    }

    // Compile Everything SDK C source on Windows
    #[cfg(target_os = "windows")]
    {
        cc::Build::new()
            .file("vendor/everything/Everything.c")
            .compile("everything");
    }

    tauri_build::build()
}
