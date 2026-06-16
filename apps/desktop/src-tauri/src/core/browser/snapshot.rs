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
