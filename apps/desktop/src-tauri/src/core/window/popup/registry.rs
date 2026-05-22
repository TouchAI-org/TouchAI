// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 弹窗注册表。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PopupConfig {
    pub id: String,
    pub width: f64,
    pub height: f64,
}

pub struct PopupRegistry {
    configs: Mutex<HashMap<String, PopupConfig>>,
}

impl PopupRegistry {
    pub fn new() -> Self {
        Self {
            configs: Mutex::new(HashMap::new()),
        }
    }

    pub fn register(&self, config: PopupConfig) -> Result<(), String> {
        let mut configs = self
            .configs
            .lock()
            .map_err(|e| format!("Failed to lock registry: {}", e))?;

        let id = config.id.clone();
        configs.insert(id, config);
        Ok(())
    }

    pub fn register_batch(&self, configs_list: Vec<PopupConfig>) -> Result<(), String> {
        for config in configs_list {
            self.register(config)?;
        }
        Ok(())
    }

    pub fn get_all(&self) -> Vec<PopupConfig> {
        let configs = self.configs.lock().unwrap();
        configs.values().cloned().collect()
    }

    pub fn has(&self, id: &str) -> bool {
        let configs = self.configs.lock().unwrap();
        configs.contains_key(id)
    }

    #[allow(dead_code)]
    pub fn clear(&self) {
        let mut configs = self.configs.lock().unwrap();
        configs.clear();
    }
}

impl Default for PopupRegistry {
    fn default() -> Self {
        Self::new()
    }
}
