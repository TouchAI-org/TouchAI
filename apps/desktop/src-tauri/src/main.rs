// Copyright (c) 2026. 千诚. Licensed under GPL v3

// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    touchai_lib::run()
}
