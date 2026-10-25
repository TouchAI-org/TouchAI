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

#[cfg(test)]
mod tests {
    use super::validate_browser_url;

    // A URL typed by the user or produced by the model ends up on a browser command line,
    // so a leading dash or a control character has to be refused before it gets there.

    #[test]
    fn user_gets_an_ordinary_https_url_accepted() {
        assert_eq!(
            validate_browser_url("https://example.com/path?q=1"),
            Ok("https://example.com/path?q=1".to_string())
        );
    }

    #[test]
    fn user_gets_surrounding_whitespace_trimmed() {
        assert_eq!(
            validate_browser_url("  https://example.com  "),
            Ok("https://example.com".to_string())
        );
    }

    #[test]
    fn user_gets_about_blank_accepted_whatever_its_case() {
        assert_eq!(
            validate_browser_url("ABOUT:BLANK"),
            Ok("about:blank".to_string())
        );
    }

    #[test]
    fn user_gets_an_empty_url_refused() {
        assert_eq!(
            validate_browser_url("   "),
            Err("Browser URL must not be empty".to_string())
        );
    }

    #[test]
    fn user_gets_a_dash_prefixed_url_refused() {
        // A leading dash would be read as a command-line switch.
        assert_eq!(
            validate_browser_url("--headless"),
            Err("Browser URL contains unsafe command-line characters".to_string())
        );
    }

    #[test]
    fn user_gets_a_control_character_refused() {
        assert_eq!(
            validate_browser_url("https://example.com\u{0000}"),
            Err("Browser URL contains unsafe command-line characters".to_string())
        );
    }

    #[test]
    fn user_gets_a_non_http_scheme_refused() {
        assert_eq!(
            validate_browser_url("file:///etc/passwd"),
            Err("Browser URL must use http, https, or about:blank".to_string())
        );
    }

    #[test]
    fn user_gets_a_relative_url_refused() {
        assert_eq!(
            validate_browser_url("example.com"),
            Err("Browser URL must be an absolute http or https URL".to_string())
        );
    }
}
