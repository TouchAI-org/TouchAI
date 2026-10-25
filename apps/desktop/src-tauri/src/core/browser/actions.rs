use super::{
    endpoint::validate_stale_navigation_token,
    types::{BrowserActOperation, BrowserActRequest, BrowserDomRef},
};

const MAX_ACTION_TEXT_BYTES: usize = 16 * 1024;
const MAX_ACTION_KEY_BYTES: usize = 64;
const MAX_FORM_FIELDS: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserResolvedFormField {
    pub navigation_token: String,
    pub selector: String,
    pub value: String,
}

#[derive(Debug, Clone)]
pub struct BrowserResolvedAction<'a> {
    pub reference: Option<&'a BrowserDomRef>,
    pub form_fields: Vec<BrowserResolvedFormField>,
    pub page_navigation_token: Option<String>,
    pub requires_current_observation: bool,
}

pub fn action_ref_id(request: &BrowserActRequest) -> Option<&str> {
    request.ref_id.as_deref().or(request.target_ref.as_deref())
}

pub fn resolve_ref_action<'a>(
    request: &BrowserActRequest,
    refs: &'a [BrowserDomRef],
) -> Result<BrowserResolvedAction<'a>, String> {
    match request.action {
        BrowserActOperation::Type => {
            let text = request
                .text
                .as_deref()
                .ok_or_else(|| "type requires text".to_string())?;
            validate_action_text(text)?;
        }
        BrowserActOperation::Fill => {
            let value = request
                .value
                .as_deref()
                .ok_or_else(|| "fill requires value".to_string())?;
            validate_action_text(value)?;
        }
        BrowserActOperation::PressKey => {
            let key = request
                .key
                .as_deref()
                .ok_or_else(|| "press_key requires key".to_string())?;
            if key.is_empty() || key.len() > MAX_ACTION_KEY_BYTES {
                return Err("press_key key is invalid".to_string());
            }
        }
        _ => {}
    }

    if matches!(
        request.action,
        BrowserActOperation::Click | BrowserActOperation::Type | BrowserActOperation::Fill
    ) && action_ref_id(request).is_none()
    {
        return Err("Browser click requires an observed ref and navigationToken".to_string());
    }

    if request.action == BrowserActOperation::FillForm {
        let fields = request
            .fields
            .as_ref()
            .ok_or_else(|| "fill_form requires fields".to_string())?;
        if fields.len() > MAX_FORM_FIELDS {
            return Err("fill_form field count exceeds the size limit".to_string());
        }
        let mut resolved_fields = Vec::with_capacity(fields.len());
        for field in fields {
            validate_action_text(&field.value)?;
            let reference = find_ref(refs, &field.ref_id)?;
            validate_stale_navigation_token(&field.navigation_token, &reference.navigation_token)?;
            if !reference.editable {
                return Err("Browser target is not editable".to_string());
            }
            resolved_fields.push(BrowserResolvedFormField {
                navigation_token: reference.navigation_token.clone(),
                selector: reference.selector.clone(),
                value: field.value.clone(),
            });
        }
        return Ok(BrowserResolvedAction {
            reference: None,
            form_fields: resolved_fields,
            page_navigation_token: None,
            requires_current_observation: false,
        });
    }

    let Some(ref_id) = action_ref_id(request) else {
        let requires_current_observation = matches!(
            request.action,
            BrowserActOperation::PressKey | BrowserActOperation::Scroll
        );
        return Ok(BrowserResolvedAction {
            reference: None,
            form_fields: Vec::new(),
            page_navigation_token: request.navigation_token.clone(),
            requires_current_observation,
        });
    };
    let reference = find_ref(refs, ref_id)?;
    let supplied = request
        .navigation_token
        .as_deref()
        .ok_or_else(|| "Browser action requires navigationToken for ref targets".to_string())?;
    validate_stale_navigation_token(supplied, &reference.navigation_token)?;

    if matches!(
        request.action,
        BrowserActOperation::Type | BrowserActOperation::Fill
    ) && !reference.editable
    {
        return Err("Browser target is not editable".to_string());
    }
    Ok(BrowserResolvedAction {
        reference: Some(reference),
        form_fields: Vec::new(),
        page_navigation_token: None,
        requires_current_observation: false,
    })
}

fn find_ref<'a>(refs: &'a [BrowserDomRef], ref_id: &str) -> Result<&'a BrowserDomRef, String> {
    refs.iter()
        .find(|candidate| candidate.ref_id == ref_id)
        .ok_or_else(|| format!("Browser ref '{ref_id}' was not found; observe again before acting"))
}

fn validate_action_text(value: &str) -> Result<(), String> {
    if value.len() > MAX_ACTION_TEXT_BYTES {
        Err("Browser action text exceeds the size limit".to_string())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::browser::types::BrowserFormField;

    fn dom_ref(ref_id: &str, editable: bool) -> BrowserDomRef {
        BrowserDomRef {
            ref_id: ref_id.to_string(),
            navigation_token: "nav-1".to_string(),
            description: "element".to_string(),
            editable,
            selector: format!("#{ref_id}"),
            x: 0.0,
            y: 0.0,
        }
    }

    fn request(action: BrowserActOperation) -> BrowserActRequest {
        BrowserActRequest {
            action,
            tab_id: None,
            ref_id: None,
            target_ref: None,
            navigation_token: None,
            text: None,
            value: None,
            key: None,
            delta_x: None,
            delta_y: None,
            timeout_ms: None,
            fields: None,
        }
    }

    // Every action the model can request passes through here before touching a page. A gap in
    // these checks means acting on a ref the user never saw, or on a page that has since moved.

    #[test]
    fn user_gets_a_click_resolved_against_the_observed_ref() {
        let refs = vec![dom_ref("r1", false)];
        let mut req = request(BrowserActOperation::Click);
        req.ref_id = Some("r1".to_string());
        req.navigation_token = Some("nav-1".to_string());

        let resolved = resolve_ref_action(&req, &refs).expect("a valid click resolves");

        assert_eq!(resolved.reference.map(|r| r.ref_id.as_str()), Some("r1"));
    }

    #[test]
    fn user_gets_the_target_ref_accepted_as_an_alias_for_ref_id() {
        let refs = vec![dom_ref("r1", false)];
        let mut req = request(BrowserActOperation::Click);
        req.target_ref = Some("r1".to_string());
        req.navigation_token = Some("nav-1".to_string());

        let resolved = resolve_ref_action(&req, &refs).expect("the alias must work");

        assert_eq!(resolved.reference.map(|r| r.ref_id.as_str()), Some("r1"));
    }

    #[test]
    fn user_gets_a_click_without_a_ref_refused() {
        let req = request(BrowserActOperation::Click);

        let error = resolve_ref_action(&req, &[]).expect_err("a bare click must be refused");

        assert_eq!(
            error,
            "Browser click requires an observed ref and navigationToken"
        );
    }

    #[test]
    fn user_gets_a_stale_ref_refused_after_the_page_moved() {
        let refs = vec![dom_ref("r1", false)];
        let mut req = request(BrowserActOperation::Click);
        req.ref_id = Some("r1".to_string());
        req.navigation_token = Some("nav-2".to_string());

        let error = resolve_ref_action(&req, &refs).expect_err("a stale ref must be refused");

        assert_eq!(error, "Browser ref is stale; observe again before acting");
    }

    #[test]
    fn user_gets_an_unknown_ref_refused_with_a_hint_to_observe_again() {
        let mut req = request(BrowserActOperation::Click);
        req.ref_id = Some("missing".to_string());
        req.navigation_token = Some("nav-1".to_string());

        let error = resolve_ref_action(&req, &[]).expect_err("an unknown ref must be refused");

        assert_eq!(
            error,
            "Browser ref 'missing' was not found; observe again before acting"
        );
    }

    #[test]
    fn user_gets_a_ref_target_refused_when_the_token_is_missing() {
        let refs = vec![dom_ref("r1", false)];
        let mut req = request(BrowserActOperation::Click);
        req.ref_id = Some("r1".to_string());

        let error = resolve_ref_action(&req, &refs).expect_err("a missing token must be refused");

        assert_eq!(
            error,
            "Browser action requires navigationToken for ref targets"
        );
    }

    #[test]
    fn user_gets_typing_into_a_non_editable_ref_refused() {
        let refs = vec![dom_ref("r1", false)];
        let mut req = request(BrowserActOperation::Type);
        req.ref_id = Some("r1".to_string());
        req.navigation_token = Some("nav-1".to_string());
        req.text = Some("hello".to_string());

        let error =
            resolve_ref_action(&req, &refs).expect_err("a read-only target must be refused");

        assert_eq!(error, "Browser target is not editable");
    }

    #[test]
    fn user_gets_typing_into_an_editable_ref_accepted() {
        let refs = vec![dom_ref("r1", true)];
        let mut req = request(BrowserActOperation::Type);
        req.ref_id = Some("r1".to_string());
        req.navigation_token = Some("nav-1".to_string());
        req.text = Some("hello".to_string());

        assert!(resolve_ref_action(&req, &refs).is_ok());
    }

    #[test]
    fn user_gets_typing_without_text_refused() {
        let mut req = request(BrowserActOperation::Type);
        req.ref_id = Some("r1".to_string());
        req.navigation_token = Some("nav-1".to_string());

        let error = resolve_ref_action(&req, &[]).expect_err("missing text must be refused");

        assert_eq!(error, "type requires text");
    }

    #[test]
    fn user_gets_filling_without_a_value_refused() {
        let mut req = request(BrowserActOperation::Fill);
        req.ref_id = Some("r1".to_string());
        req.navigation_token = Some("nav-1".to_string());

        let error = resolve_ref_action(&req, &[]).expect_err("missing value must be refused");

        assert_eq!(error, "fill requires value");
    }

    #[test]
    fn user_gets_oversized_action_text_refused() {
        let refs = vec![dom_ref("r1", true)];
        let mut req = request(BrowserActOperation::Type);
        req.ref_id = Some("r1".to_string());
        req.navigation_token = Some("nav-1".to_string());
        req.text = Some("a".repeat(MAX_ACTION_TEXT_BYTES + 1));

        let error = resolve_ref_action(&req, &refs).expect_err("oversized text must be refused");

        assert_eq!(error, "Browser action text exceeds the size limit");
    }

    #[test]
    fn user_gets_a_key_press_accepted_without_a_ref() {
        let mut req = request(BrowserActOperation::PressKey);
        req.key = Some("Enter".to_string());

        let resolved = resolve_ref_action(&req, &[]).expect("a key press needs no ref");

        assert!(resolved.reference.is_none());
        // The page may have moved since the last observation, so it must be re-read first.
        assert!(resolved.requires_current_observation);
    }

    #[test]
    fn user_gets_a_key_press_without_a_key_refused() {
        let req = request(BrowserActOperation::PressKey);

        let error = resolve_ref_action(&req, &[]).expect_err("missing key must be refused");

        assert_eq!(error, "press_key requires key");
    }

    #[test]
    fn user_gets_an_empty_key_refused() {
        let mut req = request(BrowserActOperation::PressKey);
        req.key = Some(String::new());

        let error = resolve_ref_action(&req, &[]).expect_err("an empty key must be refused");

        assert_eq!(error, "press_key key is invalid");
    }

    #[test]
    fn user_gets_an_oversized_key_refused() {
        let mut req = request(BrowserActOperation::PressKey);
        req.key = Some("k".repeat(MAX_ACTION_KEY_BYTES + 1));

        let error = resolve_ref_action(&req, &[]).expect_err("an oversized key must be refused");

        assert_eq!(error, "press_key key is invalid");
    }

    #[test]
    fn user_gets_a_scroll_accepted_and_flagged_for_a_fresh_observation() {
        let mut req = request(BrowserActOperation::Scroll);
        req.delta_y = Some(200);

        let resolved = resolve_ref_action(&req, &[]).expect("a scroll needs no ref");

        assert!(resolved.requires_current_observation);
    }

    #[test]
    fn user_gets_a_form_filled_from_the_observed_refs() {
        let refs = vec![dom_ref("name", true), dom_ref("email", true)];
        let mut req = request(BrowserActOperation::FillForm);
        req.fields = Some(vec![
            BrowserFormField {
                ref_id: "name".to_string(),
                navigation_token: "nav-1".to_string(),
                value: "Ada".to_string(),
            },
            BrowserFormField {
                ref_id: "email".to_string(),
                navigation_token: "nav-1".to_string(),
                value: "ada@example.com".to_string(),
            },
        ]);

        let resolved = resolve_ref_action(&req, &refs).expect("a valid form fill resolves");

        assert_eq!(resolved.form_fields.len(), 2);
        assert_eq!(resolved.form_fields[0].selector, "#name");
        assert_eq!(resolved.form_fields[1].value, "ada@example.com");
    }

    #[test]
    fn user_gets_a_form_fill_refused_when_a_field_is_not_editable() {
        let refs = vec![dom_ref("name", false)];
        let mut req = request(BrowserActOperation::FillForm);
        req.fields = Some(vec![BrowserFormField {
            ref_id: "name".to_string(),
            navigation_token: "nav-1".to_string(),
            value: "Ada".to_string(),
        }]);

        let error = resolve_ref_action(&req, &refs).expect_err("a read-only field must be refused");

        assert_eq!(error, "Browser target is not editable");
    }

    #[test]
    fn user_gets_a_form_fill_refused_when_a_field_moved() {
        let refs = vec![dom_ref("name", true)];
        let mut req = request(BrowserActOperation::FillForm);
        req.fields = Some(vec![BrowserFormField {
            ref_id: "name".to_string(),
            navigation_token: "nav-old".to_string(),
            value: "Ada".to_string(),
        }]);

        let error = resolve_ref_action(&req, &refs).expect_err("a stale field must be refused");

        assert_eq!(error, "Browser ref is stale; observe again before acting");
    }

    #[test]
    fn user_gets_a_form_fill_without_fields_refused() {
        let req = request(BrowserActOperation::FillForm);

        let error = resolve_ref_action(&req, &[]).expect_err("missing fields must be refused");

        assert_eq!(error, "fill_form requires fields");
    }

    #[test]
    fn user_gets_a_form_with_too_many_fields_refused() {
        let mut req = request(BrowserActOperation::FillForm);
        req.fields = Some(
            (0..=MAX_FORM_FIELDS)
                .map(|index| BrowserFormField {
                    ref_id: format!("f{index}"),
                    navigation_token: "nav-1".to_string(),
                    value: "v".to_string(),
                })
                .collect(),
        );

        let error = resolve_ref_action(&req, &[]).expect_err("too many fields must be refused");

        assert_eq!(error, "fill_form field count exceeds the size limit");
    }

    #[test]
    fn user_gets_a_wait_accepted_without_a_ref_or_a_reobservation() {
        let mut req = request(BrowserActOperation::Wait);
        req.timeout_ms = Some(1000);

        let resolved = resolve_ref_action(&req, &[]).expect("a wait needs nothing");

        assert!(resolved.reference.is_none());
        assert!(!resolved.requires_current_observation);
    }
}
