use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use serde_json::Value;

use super::PointerPosition;

#[derive(Default)]
pub(super) struct Feedback {
    targets: BTreeMap<String, (PointerPosition, Instant)>,
}

impl Feedback {
    pub const fn new() -> Self {
        Self {
            targets: BTreeMap::new(),
        }
    }

    pub fn clear(&mut self) {
        self.targets.clear();
    }

    pub fn observe(&mut self, result: &Value) {
        let envelope = &result["structuredContent"];
        if envelope["ok"] != true {
            return;
        }
        self.targets
            .retain(|_, (_, observed)| observed.elapsed() < Duration::from_secs(60));
        self.observe_tree(&envelope["data"]["tree"]);
        if envelope["command"] == "batch" {
            if let Some(results) = envelope["data"]["results"].as_array() {
                for result in results.iter().filter(|result| result["ok"] == true) {
                    self.observe_tree(&result["data"]["tree"]);
                }
            }
        }
    }

    fn observe_tree(&mut self, node: &Value) {
        if let (Some(reference), Some(point)) = (node["ref_id"].as_str(), center(&node["bounds"])) {
            if self.targets.len() >= 2048 {
                self.targets.pop_first();
            }
            self.targets
                .insert(reference.into(), (point, Instant::now()));
        }
        if let Some(children) = node["children"].as_array() {
            for child in children {
                self.observe_tree(child);
            }
        }
    }

    pub fn target(
        &self,
        tool: &str,
        args: &Value,
        result: Option<&Value>,
    ) -> Option<PointerPosition> {
        if super::is_read_only(tool) {
            return None;
        }
        let reference = if tool == "desktop_batch" {
            let commands: Vec<Value> =
                serde_json::from_str(args["commands_json"].as_str()?).ok()?;
            if let Some(result) = result {
                let last = result["structuredContent"]["data"]["results"]
                    .as_array()?
                    .iter()
                    .rev()
                    .find(|entry| {
                        entry["ok"] == true
                            && entry["index"]
                                .as_u64()
                                .and_then(|index| commands.get(index as usize))
                                .is_some_and(|command| command["args"]["ref_id"].is_string())
                    })?;
                commands.get(last["index"].as_u64()? as usize)?["args"]["ref_id"]
                    .as_str()?
                    .to_owned()
            } else {
                commands.first()?["args"]["ref_id"].as_str()?.to_owned()
            }
        } else {
            if result.is_some_and(|result| result["structuredContent"]["ok"] != true) {
                return None;
            }
            args["ref_id"].as_str()?.to_owned()
        };
        let (point, observed) = self.targets.get(&reference)?;
        (observed.elapsed() < Duration::from_secs(60)).then_some(*point)
    }
}

fn center(bounds: &Value) -> Option<PointerPosition> {
    let width = bounds["width"].as_f64()?;
    let height = bounds["height"].as_f64()?;
    let x = bounds["x"].as_f64()? + width / 2.0;
    let y = bounds["y"].as_f64()? + height / 2.0;
    (width > 0.0 && height > 0.0 && x.is_finite() && y.is_finite())
        .then_some(PointerPosition { x, y })
}

pub(super) fn hide_bounds(result: &mut Value) {
    fn strip(node: &mut Value) {
        if let Some(object) = node.as_object_mut() {
            object.remove("bounds");
            if let Some(children) = object.get_mut("children").and_then(Value::as_array_mut) {
                for child in children {
                    strip(child);
                }
            }
        }
    }
    strip(&mut result["structuredContent"]["data"]["tree"]);
    result["content"] =
        serde_json::json!([{ "type": "text", "text": result["structuredContent"].to_string() }]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot() -> Value {
        json!({"structuredContent":{"ok":true,"command":"snapshot","data":{"tree":{"children":[{"ref_id":"@s1:e1","bounds":{"x":100,"y":200,"width":80,"height":40}},{"ref_id":"@s1:e2","bounds":{"x":600,"y":700,"width":80,"height":40}}]}}}})
    }

    #[test]
    fn user_given_semantic_input_when_the_mouse_stays_still_then_feedback_uses_observed_target_bounds(
    ) {
        let mut feedback = Feedback::new();
        let mut observed = snapshot();
        feedback.observe(&observed);
        hide_bounds(&mut observed);
        assert_eq!(
            feedback.target("desktop_type", &json!({"ref_id":"@s1:e1"}), None),
            Some(PointerPosition { x: 140.0, y: 220.0 })
        );
        assert!(observed["structuredContent"]["data"]["tree"]["children"][0]
            .get("bounds")
            .is_none());
        assert_eq!(
            feedback.target("desktop_type", &json!({"ref_id":"unknown"}), None),
            None
        );
        assert_eq!(
            Feedback::new().target("desktop_type", &json!({"ref_id":"@s1:e1"}), None),
            None
        );
    }

    #[test]
    fn user_given_a_partially_failed_batch_when_showing_its_pointer_then_excludes_unstarted_targets(
    ) {
        let mut feedback = Feedback::new();
        feedback.observe(&snapshot());
        let args = json!({"commands_json":r#"[{"command":"focus","args":{"ref_id":"@s1:e1"}},{"command":"type","args":{"ref_id":"@s1:e2","text":"example"}},{"command":"click","args":{"ref_id":"@s1:e3"}}]"#});
        let result = json!({"structuredContent":{"ok":true,"data":{"results":[{"index":0,"ok":true},{"index":1,"ok":false}]}}});
        assert_eq!(
            feedback.target("desktop_batch", &args, Some(&result)),
            Some(PointerPosition { x: 140.0, y: 220.0 })
        );
        assert_eq!(
            feedback.target("desktop_snapshot", &json!({"ref_id":"@s1:e1"}), None),
            None
        );
        feedback.clear();
        assert_eq!(
            feedback.target("desktop_type", &json!({"ref_id":"@s1:e1"}), None),
            None
        );
    }
}
