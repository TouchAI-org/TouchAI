use std::sync::LazyLock;

use super::super::manifest::{load, Manifest};

pub static MANIFEST: LazyLock<Manifest<'static>> = LazyLock::new(|| load("agent-desktop"));
