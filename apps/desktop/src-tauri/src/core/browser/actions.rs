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
