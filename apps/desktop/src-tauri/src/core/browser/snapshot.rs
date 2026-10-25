use super::{
    cdp::PageSnapshot,
    types::{BrowserObservation, BrowserStatus},
};

pub fn page_observation(status: BrowserStatus, page: PageSnapshot) -> BrowserObservation {
    BrowserObservation {
        status,
        url: page.url,
        title: page.title,
        navigation_token: page.navigation_token,
        dom_refs: page.refs,
        file_path: page.file_path,
        mime_type: page.mime_type,
        console: page.console,
        network: page.network,
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::core::browser::types::BrowserStatusKind;

    fn status(kind: BrowserStatusKind) -> BrowserStatus {
        BrowserStatus {
            status: kind,
            managed: true,
            active_tab_id: Some("tab-1".to_string()),
            error: None,
            tabs: Vec::new(),
        }
    }

    // The renderer reads one observation object per action, so every field the page produced
    // has to survive the hop unchanged; a dropped field silently blanks part of the UI.

    #[test]
    fn user_sees_every_field_of_the_observed_page_carried_over() {
        let page = PageSnapshot {
            url: Some("https://example.com".to_string()),
            title: Some("Example".to_string()),
            navigation_token: Some("nav-1".to_string()),
            refs: Vec::new(),
            file_path: Some(PathBuf::from("C:/tmp/report.pdf")),
            mime_type: Some("application/pdf".to_string()),
            console: vec!["log line".to_string()],
            network: vec!["GET / 200".to_string()],
        };

        let observation = page_observation(status(BrowserStatusKind::Connected), page);

        assert_eq!(observation.status.status, BrowserStatusKind::Connected);
        assert_eq!(observation.url.as_deref(), Some("https://example.com"));
        assert_eq!(observation.title.as_deref(), Some("Example"));
        assert_eq!(observation.navigation_token.as_deref(), Some("nav-1"));
        assert_eq!(
            observation.file_path,
            Some(PathBuf::from("C:/tmp/report.pdf"))
        );
        assert_eq!(observation.mime_type.as_deref(), Some("application/pdf"));
        assert_eq!(observation.console, vec!["log line".to_string()]);
        assert_eq!(observation.network, vec!["GET / 200".to_string()]);
    }

    #[test]
    fn user_sees_an_idle_page_observation_with_no_page_details() {
        let page = PageSnapshot {
            url: None,
            title: None,
            navigation_token: None,
            refs: Vec::new(),
            file_path: None,
            mime_type: None,
            console: Vec::new(),
            network: Vec::new(),
        };

        let observation = page_observation(status(BrowserStatusKind::Idle), page);

        assert_eq!(observation.status.status, BrowserStatusKind::Idle);
        assert!(observation.url.is_none());
        assert!(observation.title.is_none());
        assert!(observation.dom_refs.is_empty());
    }
}
