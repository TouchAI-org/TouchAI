use reqwest::Url;

pub fn validate_browser_url(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.is_empty() {
        return Err("Browser URL must not be empty".to_string());
    }

    if value.starts_with('-') || value.chars().any(char::is_control) {
        return Err("Browser URL contains unsafe command-line characters".to_string());
    }

    if value.eq_ignore_ascii_case("about:blank") {
        return Ok("about:blank".to_string());
    }

    let url = Url::parse(value)
        .map_err(|_| "Browser URL must be an absolute http or https URL".to_string())?;
    match url.scheme() {
        "http" | "https" => Ok(value.to_string()),
        _ => Err("Browser URL must use http, https, or about:blank".to_string()),
    }
}
