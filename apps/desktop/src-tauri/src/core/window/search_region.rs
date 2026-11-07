// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Native search-window interaction regions.

use serde::{Deserialize, Serialize};
use std::sync::{Condvar, Mutex};
use std::thread::{self, ThreadId};
use tauri::{Runtime, WebviewWindow};

const DEFAULT_CORNER_RADIUS: f64 = 12.0;
const MAX_REGION_COUNT: usize = 2;

type PhysicalRect = (i32, i32, i32, i32);

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchWindowRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default = "default_corner_radius")]
    pub corner_radius: f64,
}

#[derive(Default)]
struct SearchRegionState {
    generation: u64,
    regions: Vec<SearchWindowRegion>,
    native_generation: Option<u64>,
    native_owner: Option<ThreadId>,
}

pub struct SearchRegionRuntime {
    state: Mutex<SearchRegionState>,
    native_complete: Condvar,
    native_enabled: bool,
}

impl SearchRegionRuntime {
    pub fn new() -> Self {
        Self::with_native_enabled(true)
    }

    pub(crate) fn for_tests() -> Self {
        Self::with_native_enabled(false)
    }

    fn with_native_enabled(native_enabled: bool) -> Self {
        Self {
            state: Mutex::new(SearchRegionState::default()),
            native_complete: Condvar::new(),
            native_enabled,
        }
    }

    pub(crate) fn native_enabled(&self) -> bool {
        self.native_enabled
    }

    #[cfg(test)]
    pub fn update(
        &self,
        generation: u64,
        regions: Vec<SearchWindowRegion>,
    ) -> Result<bool, String> {
        self.apply_and_update(generation, regions, |_| Ok(()))
    }

    pub fn apply_and_update<F>(
        &self,
        generation: u64,
        regions: Vec<SearchWindowRegion>,
        apply: F,
    ) -> Result<bool, String>
    where
        F: FnOnce(&[SearchWindowRegion]) -> Result<(), String>,
    {
        validate_regions(&regions)?;
        let current_thread = thread::current().id();
        let previous_generation = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            if generation <= state.generation {
                return Ok(false);
            }

            let previous_generation = state.generation;
            state.generation = generation;

            loop {
                match state.native_generation {
                    None => {
                        state.native_generation = Some(generation);
                        state.native_owner = Some(current_thread);
                        break previous_generation;
                    }
                    Some(_) if state.native_owner == Some(current_thread) => {
                        // A native window call may synchronously re-enter this
                        // runtime. Waiting here would deadlock on the outer
                        // callback, so reserve the newer generation and let
                        // the caller report a stale acknowledgement instead.
                        return Ok(false);
                    }
                    Some(_) => {
                        state = self
                            .native_complete
                            .wait(state)
                            .unwrap_or_else(|error| error.into_inner());
                        if state.generation != generation {
                            return Ok(false);
                        }
                    }
                }
            }
        };

        // Native window APIs can synchronously re-enter the application. Do not hold
        // hold the state lock across the callback; production commands are
        // dispatched to the Tauri main thread before reaching this runtime.
        let apply_result = apply(&regions);

        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let is_current = generation == state.generation;
        debug_assert_eq!(state.native_generation, Some(generation));
        debug_assert_eq!(state.native_owner, Some(current_thread));
        state.native_generation = None;
        state.native_owner = None;
        self.native_complete.notify_all();

        match apply_result {
            Ok(()) if is_current => {
                state.regions = regions;
                Ok(true)
            }
            Ok(()) => Ok(false),
            Err(error) => {
                if is_current {
                    state.generation = previous_generation;
                }
                Err(error)
            }
        }
    }

    pub fn with_current_generation<T, F>(
        &self,
        generation: u64,
        action: F,
    ) -> Result<Option<T>, String>
    where
        F: FnOnce() -> Result<T, String>,
    {
        let is_current = self.generation() == generation;
        if !is_current {
            return Ok(None);
        }
        action().map(Some)
    }

    #[cfg(test)]
    pub fn snapshot(&self) -> Vec<SearchWindowRegion> {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .regions
            .clone()
    }

    pub(crate) fn generation(&self) -> u64 {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .generation
    }
}

impl Default for SearchRegionRuntime {
    fn default() -> Self {
        Self::new()
    }
}

fn default_corner_radius() -> f64 {
    DEFAULT_CORNER_RADIUS
}

fn validate_regions(regions: &[SearchWindowRegion]) -> Result<(), String> {
    if !(1..=MAX_REGION_COUNT).contains(&regions.len()) {
        return Err("Search window regions must contain one or two entries".to_string());
    }

    if regions.iter().any(|region| {
        !region.x.is_finite()
            || !region.y.is_finite()
            || !region.width.is_finite()
            || !region.height.is_finite()
            || !region.corner_radius.is_finite()
            || region.width <= 0.0
            || region.height <= 0.0
            || region.corner_radius < 0.0
            || !region
                .x
                .checked_add(region.width)
                .is_some_and(f64::is_finite)
            || !region
                .y
                .checked_add(region.height)
                .is_some_and(f64::is_finite)
    }) {
        return Err("Search window region geometry is invalid".to_string());
    }

    Ok(())
}

trait CheckedAddF64 {
    fn checked_add(self, rhs: f64) -> Option<f64>;
}

impl CheckedAddF64 for f64 {
    fn checked_add(self, rhs: f64) -> Option<f64> {
        let sum = self + rhs;
        sum.is_finite().then_some(sum)
    }
}

fn logical_rect_to_physical(
    region: &SearchWindowRegion,
    scale_factor: f64,
) -> Option<(i32, i32, i32, i32, i32)> {
    if !scale_factor.is_finite()
        || scale_factor <= 0.0
        || validate_regions(std::slice::from_ref(region)).is_err()
    {
        return None;
    }

    let left = (region.x * scale_factor).floor();
    let top = (region.y * scale_factor).floor();
    let right = ((region.x + region.width) * scale_factor).ceil();
    let bottom = ((region.y + region.height) * scale_factor).ceil();
    let diameter = (region.corner_radius * 2.0 * scale_factor).round();

    if [left, top, right, bottom, diameter]
        .iter()
        .any(|value| *value < i32::MIN as f64 || *value > i32::MAX as f64)
    {
        return None;
    }

    Some((
        left as i32,
        top as i32,
        right as i32,
        bottom as i32,
        diameter.max(1.0) as i32,
    ))
}

fn translate_client_rect_to_window(
    rect: PhysicalRect,
    client_screen_origin: (i32, i32),
    window_screen_origin: (i32, i32),
) -> Option<PhysicalRect> {
    let offset_x = client_screen_origin.0.checked_sub(window_screen_origin.0)?;
    let offset_y = client_screen_origin.1.checked_sub(window_screen_origin.1)?;
    Some((
        rect.0.checked_add(offset_x)?,
        rect.1.checked_add(offset_y)?,
        rect.2.checked_add(offset_x)?,
        rect.3.checked_add(offset_y)?,
    ))
}

pub fn apply_search_window_regions<R: Runtime>(
    window: &WebviewWindow<R>,
    regions: &[SearchWindowRegion],
) -> Result<(), String> {
    validate_regions(regions)?;
    apply_window_regions_impl(window, regions, "main")
}

#[cfg(target_os = "windows")]
fn apply_window_regions_impl<R: Runtime>(
    window: &WebviewWindow<R>,
    regions: &[SearchWindowRegion],
    expected_label: &str,
) -> Result<(), String> {
    use raw_window_handle::HasWindowHandle;
    use windows::Win32::{
        Foundation::{HWND, POINT, RECT},
        Graphics::Gdi::{
            ClientToScreen, CombineRgn, CreateRectRgn, CreateRoundRectRgn, DeleteObject,
            SetWindowRgn, HGDIOBJ, RGN_ERROR, RGN_OR,
        },
        UI::WindowsAndMessaging::{GetClientRect, GetWindowRect},
    };

    if window.label() != expected_label {
        return Err(format!(
            "Search regions for '{expected_label}' cannot be applied to '{}'",
            window.label()
        ));
    }

    let window_handle = window
        .window_handle()
        .map_err(|error| format!("Failed to get search window handle: {error}"))?;
    let hwnd = match window_handle.as_ref() {
        raw_window_handle::RawWindowHandle::Win32(handle) => HWND(handle.hwnd.get() as _),
        _ => return Err("Search window does not have a Win32 handle".to_string()),
    };
    let scale_factor = window
        .scale_factor()
        .map_err(|error| format!("Failed to read search window scale factor: {error}"))?;

    unsafe {
        let mut client_rect = RECT::default();
        GetClientRect(hwnd, &mut client_rect)
            .map_err(|error| format!("Failed to read search client rect: {error}"))?;
        let mut client_origin = POINT {
            x: client_rect.left,
            y: client_rect.top,
        };
        if !ClientToScreen(hwnd, &mut client_origin).as_bool() {
            return Err(format!(
                "Failed to map search client coordinates: {}",
                windows::core::Error::from_thread()
            ));
        }
        let mut window_rect = RECT::default();
        GetWindowRect(hwnd, &mut window_rect)
            .map_err(|error| format!("Failed to read search window rect: {error}"))?;

        let union_region = CreateRectRgn(0, 0, 0, 0);
        if union_region.is_invalid() {
            return Err(format!(
                "Failed to create search window union region: {}",
                windows::core::Error::from_thread()
            ));
        }

        for region in regions {
            let (left, top, right, bottom, diameter) =
                logical_rect_to_physical(region, scale_factor)
                    .ok_or_else(|| "Validated search region could not be converted".to_string())?;
            let (left, top, right, bottom) = translate_client_rect_to_window(
                (left, top, right, bottom),
                (client_origin.x, client_origin.y),
                (window_rect.left, window_rect.top),
            )
            .ok_or_else(|| "Search region coordinate translation overflowed".to_string())?;
            let rounded = CreateRoundRectRgn(left, top, right, bottom, diameter, diameter);
            if rounded.is_invalid() {
                let error = windows::core::Error::from_thread();
                let _ = DeleteObject(HGDIOBJ(union_region.0));
                return Err(format!(
                    "Failed to create rounded search window region: {error}"
                ));
            }
            let combine_result = CombineRgn(
                Some(union_region),
                Some(union_region),
                Some(rounded),
                RGN_OR,
            );
            if combine_result == RGN_ERROR {
                let error = windows::core::Error::from_thread();
                let _ = DeleteObject(HGDIOBJ(rounded.0));
                let _ = DeleteObject(HGDIOBJ(union_region.0));
                return Err(format!("Failed to combine search window regions: {error}"));
            }
            let _ = DeleteObject(HGDIOBJ(rounded.0));
        }

        if SetWindowRgn(hwnd, Some(union_region), true) == 0 {
            let error = windows::core::Error::from_thread();
            let _ = DeleteObject(HGDIOBJ(union_region.0));
            return Err(format!("Failed to apply search window region: {error}"));
        }
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn apply_window_regions_impl<R: Runtime>(
    _window: &WebviewWindow<R>,
    _regions: &[SearchWindowRegion],
    _expected_label: &str,
) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    use super::{
        logical_rect_to_physical, translate_client_rect_to_window, SearchRegionRuntime,
        SearchWindowRegion,
    };

    fn region(x: f64) -> SearchWindowRegion {
        SearchWindowRegion {
            x,
            y: 20.5,
            width: 100.5,
            height: 50.25,
            corner_radius: 12.0,
        }
    }

    #[test]
    fn logical_rect_uses_outward_rounding_at_mixed_dpi() {
        assert_eq!(
            logical_rect_to_physical(&region(10.25), 1.5),
            Some((15, 30, 167, 107, 36))
        );
    }

    #[test]
    fn runtime_validation_is_atomic_and_retains_last_good_regions() {
        let runtime = SearchRegionRuntime::new();
        let first = vec![region(1.0)];
        runtime.update(1, first.clone()).unwrap();

        let mut invalid = region(2.0);
        invalid.corner_radius = -1.0;
        assert!(runtime.update(2, vec![region(3.0), invalid]).is_err());
        assert_eq!(runtime.snapshot(), first);
        assert_eq!(runtime.generation(), 1);
        runtime
            .apply_and_update(2, vec![region(2.0)], |_| Ok(()))
            .unwrap();
        assert_eq!(runtime.generation(), 2);
    }

    #[test]
    fn runtime_rejects_invalid_count_and_nonfinite_coordinate_sums() {
        let runtime = SearchRegionRuntime::new();
        assert!(runtime.update(1, Vec::new()).is_err());
        assert!(runtime
            .update(1, vec![region(0.0), region(1.0), region(2.0)])
            .is_err());

        let mut overflow = region(f64::MAX);
        overflow.width = f64::MAX;
        assert!(runtime.update(1, vec![overflow]).is_err());
        assert!(runtime.snapshot().is_empty());
    }

    #[test]
    fn failed_native_application_retains_last_good_regions() {
        let runtime = SearchRegionRuntime::new();
        let first = vec![region(1.0)];
        runtime
            .apply_and_update(1, first.clone(), |_| Ok(()))
            .unwrap();

        let error = runtime
            .apply_and_update(2, vec![region(2.0)], |_| {
                Err("native apply failed".to_string())
            })
            .unwrap_err();

        assert_eq!(error, "native apply failed");
        assert_eq!(runtime.snapshot(), first);
    }

    #[test]
    fn latest_valid_payload_replaces_previous_regions() {
        let runtime = SearchRegionRuntime::new();
        runtime.update(1, vec![region(1.0)]).unwrap();
        let latest = vec![region(2.0), region(3.0)];
        runtime.update(2, latest.clone()).unwrap();
        assert_eq!(runtime.snapshot(), latest);
    }

    #[test]
    fn stale_generation_is_rejected_before_native_application() {
        let runtime = SearchRegionRuntime::new();
        let latest = vec![region(2.0)];

        assert_eq!(
            runtime.apply_and_update(2, latest.clone(), |_| Ok(())),
            Ok(true)
        );
        assert_eq!(
            runtime.apply_and_update(1, vec![region(1.0)], |_| {
                panic!("stale geometry must not reach native application")
            }),
            Ok(false)
        );
        assert_eq!(runtime.snapshot(), latest);
    }

    #[test]
    fn native_application_can_reenter_snapshot_without_state_lock() {
        let runtime = SearchRegionRuntime::new();
        let next = vec![region(4.0)];

        runtime
            .apply_and_update(1, next.clone(), |_| {
                assert!(runtime.snapshot().is_empty());
                Ok(())
            })
            .unwrap();

        assert_eq!(runtime.snapshot(), next);
    }

    #[test]
    fn native_application_can_reenter_region_runtime_without_state_lock() {
        let runtime = SearchRegionRuntime::new();

        runtime
            .apply_and_update(1, vec![region(5.0)], |_| {
                assert!(runtime.state.try_lock().is_ok());
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn native_applications_are_serialized_in_generation_order() {
        let runtime = Arc::new(SearchRegionRuntime::new());
        let first_started = Arc::new(Barrier::new(2));
        let first_release = Arc::new(Barrier::new(2));
        let events = Arc::new(Mutex::new(Vec::new()));

        let first_runtime = Arc::clone(&runtime);
        let first_started_for_thread = Arc::clone(&first_started);
        let first_release_for_thread = Arc::clone(&first_release);
        let first_events = Arc::clone(&events);
        let first = thread::spawn(move || {
            first_runtime
                .apply_and_update(1, vec![region(6.0)], |_| {
                    first_events.lock().unwrap().push("start-1");
                    first_started_for_thread.wait();
                    first_release_for_thread.wait();
                    first_events.lock().unwrap().push("end-1");
                    Ok(())
                })
                .unwrap()
        });

        first_started.wait();

        let second_runtime = Arc::clone(&runtime);
        let second_events = Arc::clone(&events);
        let second = thread::spawn(move || {
            second_runtime
                .apply_and_update(2, vec![region(7.0)], |_| {
                    second_events.lock().unwrap().push("start-2");
                    second_events.lock().unwrap().push("end-2");
                    Ok(())
                })
                .unwrap()
        });

        let second_reservation_deadline = Instant::now() + Duration::from_secs(5);
        while runtime.generation() < 2 {
            assert!(
                Instant::now() < second_reservation_deadline,
                "second generation was not reserved while first native application was in flight"
            );
            thread::sleep(Duration::from_millis(1));
        }
        first_release.wait();
        assert!(!first.join().unwrap());
        assert!(second.join().unwrap());

        assert_eq!(
            *events.lock().unwrap(),
            vec!["start-1", "end-1", "start-2", "end-2"]
        );
        assert_eq!(runtime.generation(), 2);
        assert_eq!(runtime.snapshot(), vec![region(7.0)]);
    }

    #[test]
    fn newer_generation_reservation_blocks_reentrant_older_native_application() {
        let runtime = SearchRegionRuntime::new();
        let latest = vec![region(2.0)];
        let older_native_application_called = std::cell::Cell::new(false);

        assert_eq!(
            runtime.apply_and_update(2, latest.clone(), |_| {
                assert_eq!(
                    runtime.apply_and_update(1, vec![region(1.0)], |_| {
                        older_native_application_called.set(true);
                        Ok(())
                    }),
                    Ok(false)
                );
                Ok(())
            }),
            Ok(true)
        );

        assert!(!older_native_application_called.get());
        assert_eq!(runtime.generation(), 2);
        assert_eq!(runtime.snapshot(), latest);
    }

    #[test]
    fn client_rect_translation_accounts_for_nonclient_offset() {
        assert_eq!(
            translate_client_rect_to_window((15, 30, 167, 107), (110, 220), (100, 200)),
            Some((25, 50, 177, 127))
        );
        assert_eq!(
            translate_client_rect_to_window((i32::MAX, 0, i32::MAX, 10), (1, 0), (0, 0)),
            None
        );
    }
}
