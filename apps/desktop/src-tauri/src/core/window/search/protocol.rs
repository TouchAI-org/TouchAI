// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Pure visibility protocol for the main search surface.

/// Logical phase of the main search surface visibility transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchSurfacePhase {
    Hidden,
    PreparingHost,
    Preparing,
    Activating,
    Visible,
}

impl SearchSurfacePhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hidden => "hidden",
            Self::PreparingHost => "preparing_host",
            Self::Preparing => "preparing",
            Self::Activating => "activating",
            Self::Visible => "visible",
        }
    }
}

/// Source that requested the search surface to become visible.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchSurfaceSource {
    Shortcut,
    Notification,
    Tray,
    Main,
}

impl SearchSurfaceSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Shortcut => "shortcut",
            Self::Notification => "notification",
            Self::Tray => "tray",
            Self::Main => "main",
        }
    }
}

/// Action for one global-shortcut press.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchShortcutAction {
    Show,
    FocusVisible,
    Hide,
}

/// Token captured before the native host preparation begins.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchHostPreparationRequest {
    pub renderer_epoch: u64,
    pub show_epoch: u64,
    pub source: SearchSurfaceSource,
}

/// Token sent to the renderer after the final native host geometry is known.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchSurfacePreparation {
    pub renderer_epoch: u64,
    pub show_epoch: u64,
    pub host_epoch: u64,
    pub source: SearchSurfaceSource,
}

/// Token committed only after the matching final region was applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SearchSurfaceActivation {
    pub renderer_epoch: u64,
    pub show_epoch: u64,
    pub host_epoch: u64,
    pub region_generation: u64,
    pub source: SearchSurfaceSource,
}

/// Pure state machine for search-surface visibility.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchSurfaceProtocol {
    phase: SearchSurfacePhase,
    renderer_epoch: u64,
    renderer_ready: bool,
    desired_visible: bool,
    show_epoch: u64,
    host_epoch: u64,
    source: Option<SearchSurfaceSource>,
    preparation: Option<SearchSurfacePreparation>,
    activation: Option<SearchSurfaceActivation>,
    last_shown: Option<SearchSurfaceActivation>,
}

impl SearchSurfaceProtocol {
    pub fn new() -> Self {
        Self {
            phase: SearchSurfacePhase::Hidden,
            renderer_epoch: 1,
            renderer_ready: false,
            desired_visible: false,
            show_epoch: 0,
            host_epoch: 0,
            source: None,
            preparation: None,
            activation: None,
            last_shown: None,
        }
    }

    pub fn phase(&self) -> SearchSurfacePhase {
        self.phase
    }

    pub fn renderer_ready(&self) -> bool {
        self.renderer_ready
    }

    pub fn desired_visible(&self) -> bool {
        self.desired_visible
    }

    pub fn source(&self) -> Option<SearchSurfaceSource> {
        self.source
    }

    pub fn preparation(&self) -> Option<SearchSurfacePreparation> {
        self.preparation
    }

    pub fn last_shown(&self) -> Option<SearchSurfaceActivation> {
        self.last_shown
    }

    pub fn renderer_epoch(&self) -> u64 {
        self.renderer_epoch
    }

    pub fn request_show(
        &mut self,
        source: SearchSurfaceSource,
    ) -> Option<SearchHostPreparationRequest> {
        if self.phase == SearchSurfacePhase::Visible && self.desired_visible {
            self.source = Some(source);
            return None;
        }
        self.show_epoch = next_epoch(self.show_epoch, "search show");
        self.desired_visible = true;
        self.source = Some(source);
        self.preparation = None;
        self.activation = None;
        self.last_shown = None;

        if !self.renderer_ready {
            self.phase = SearchSurfacePhase::Hidden;
            return None;
        }

        self.phase = SearchSurfacePhase::PreparingHost;
        Some(self.current_host_request(source))
    }

    pub fn mark_renderer_ready(
        &mut self,
        renderer_epoch: u64,
    ) -> Option<SearchHostPreparationRequest> {
        if renderer_epoch != self.renderer_epoch || self.renderer_ready {
            return None;
        }

        self.renderer_ready = true;
        let source = self.source?;
        if !self.desired_visible {
            return None;
        }

        self.phase = SearchSurfacePhase::PreparingHost;
        Some(self.current_host_request(source))
    }

    pub fn host_prepared(
        &mut self,
        request: SearchHostPreparationRequest,
    ) -> Option<SearchSurfacePreparation> {
        if self.phase != SearchSurfacePhase::PreparingHost
            || !self.renderer_ready
            || !self.desired_visible
            || request.renderer_epoch != self.renderer_epoch
            || request.show_epoch != self.show_epoch
            || Some(request.source) != self.source
        {
            return None;
        }

        self.host_epoch = next_epoch(self.host_epoch, "search host");
        let preparation = SearchSurfacePreparation {
            renderer_epoch: self.renderer_epoch,
            show_epoch: self.show_epoch,
            host_epoch: self.host_epoch,
            source: request.source,
        };
        self.preparation = Some(preparation);
        self.phase = SearchSurfacePhase::Preparing;
        Some(preparation)
    }

    pub fn request_host_refresh(&mut self) -> Option<SearchHostPreparationRequest> {
        if !matches!(
            self.phase,
            SearchSurfacePhase::Preparing
                | SearchSurfacePhase::Activating
                | SearchSurfacePhase::Visible
        ) || !self.renderer_ready
            || !self.desired_visible
        {
            return None;
        }
        let source = self.source?;
        self.preparation = None;
        self.activation = None;
        self.last_shown = None;
        self.phase = SearchSurfacePhase::PreparingHost;
        Some(self.current_host_request(source))
    }

    pub fn region_applied(
        &mut self,
        preparation: SearchSurfacePreparation,
        region_generation: u64,
    ) -> Option<SearchSurfaceActivation> {
        if region_generation == 0
            || self.phase != SearchSurfacePhase::Preparing
            || !self.desired_visible
            || self.preparation != Some(preparation)
            || preparation.renderer_epoch != self.renderer_epoch
            || preparation.show_epoch != self.show_epoch
            || preparation.host_epoch != self.host_epoch
        {
            return None;
        }

        let activation = SearchSurfaceActivation {
            renderer_epoch: preparation.renderer_epoch,
            show_epoch: preparation.show_epoch,
            host_epoch: preparation.host_epoch,
            region_generation,
            source: preparation.source,
        };
        self.preparation = None;
        self.activation = Some(activation);
        self.phase = SearchSurfacePhase::Activating;
        Some(activation)
    }

    pub fn activation_succeeded(
        &mut self,
        activation: SearchSurfaceActivation,
    ) -> Option<SearchSurfaceActivation> {
        if self.phase != SearchSurfacePhase::Activating
            || !self.desired_visible
            || self.activation != Some(activation)
            || activation.renderer_epoch != self.renderer_epoch
            || activation.show_epoch != self.show_epoch
            || activation.host_epoch != self.host_epoch
        {
            return None;
        }

        self.activation = None;
        self.phase = SearchSurfacePhase::Visible;
        self.last_shown = Some(activation);
        Some(activation)
    }

    pub fn activation_failed(&mut self, activation: SearchSurfaceActivation) {
        if self.phase != SearchSurfacePhase::Activating || self.activation != Some(activation) {
            return;
        }
        self.show_epoch = next_epoch(self.show_epoch, "search show");
        self.desired_visible = false;
        self.source = None;
        self.preparation = None;
        self.activation = None;
        self.last_shown = None;
        self.phase = SearchSurfacePhase::Hidden;
    }

    pub fn hide(&mut self) {
        self.show_epoch = next_epoch(self.show_epoch, "search show");
        self.desired_visible = false;
        self.source = None;
        self.preparation = None;
        self.activation = None;
        self.last_shown = None;
        self.phase = SearchSurfacePhase::Hidden;
    }

    pub fn page_load_started(&mut self) -> u64 {
        self.renderer_epoch = next_epoch(self.renderer_epoch, "search renderer");
        self.renderer_ready = false;
        self.preparation = None;
        self.activation = None;
        self.last_shown = None;
        self.phase = SearchSurfacePhase::Hidden;
        self.renderer_epoch
    }

    pub fn resolve_shortcut_action(
        &self,
        is_visible: bool,
        is_app_focused: bool,
    ) -> SearchShortcutAction {
        if self.phase == SearchSurfacePhase::Visible {
            return if is_visible && is_app_focused {
                SearchShortcutAction::Hide
            } else {
                SearchShortcutAction::FocusVisible
            };
        }
        if self.desired_visible {
            return SearchShortcutAction::Hide;
        }
        if !is_visible {
            return SearchShortcutAction::Show;
        }
        if is_app_focused {
            SearchShortcutAction::Hide
        } else {
            SearchShortcutAction::FocusVisible
        }
    }

    fn current_host_request(&self, source: SearchSurfaceSource) -> SearchHostPreparationRequest {
        SearchHostPreparationRequest {
            renderer_epoch: self.renderer_epoch,
            show_epoch: self.show_epoch,
            source,
        }
    }
}

impl Default for SearchSurfaceProtocol {
    fn default() -> Self {
        Self::new()
    }
}

fn next_epoch(current: u64, name: &str) -> u64 {
    current
        .checked_add(1)
        .unwrap_or_else(|| panic!("{name} epoch exhausted"))
}
