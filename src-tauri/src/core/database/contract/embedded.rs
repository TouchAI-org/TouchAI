// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Release 构建使用的数据库契约内嵌资产。

pub(super) fn read_text(segments: &[&str]) -> Option<&'static str> {
    match segments {
        ["drizzle", "meta", "_journal.json"] => Some(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/database/drizzle/meta/_journal.json"
        ))),
        ["drizzle", "0000_lyrical_toad.sql"] => Some(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/database/drizzle/0000_lyrical_toad.sql"
        ))),
        ["artifacts", "runtime", "guards.sql"] => Some(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/database/artifacts/runtime/guards.sql"
        ))),
        ["artifacts", "runtime", "seed.sql"] => Some(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/database/artifacts/runtime/seed.sql"
        ))),
        ["artifacts", "import", "chat_merge.sql"] => Some(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/database/artifacts/import/chat_merge.sql"
        ))),
        ["artifacts", "import", "full_prelude.sql"] => Some(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/database/artifacts/import/full_prelude.sql"
        ))),
        ["artifacts", "import", "full_postlude.sql"] => Some(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/database/artifacts/import/full_postlude.sql"
        ))),
        _ => None,
    }
}
