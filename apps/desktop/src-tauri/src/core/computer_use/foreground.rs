use serde_json::Value;

use super::backend::DriverId;

pub fn uses_foreground(driver: DriverId, tool: &str, args: &Value, headed: bool) -> bool {
    if driver == DriverId::AgentDesktop {
        return headed && agent_action(tool, args);
    }
    match tool {
        "bring_to_front" | "set_window_frame" | "run_script" | "replay_trajectory" => true,
        "run_steps" => {
            args["delivery_mode"] == "foreground"
                || args["steps"].as_array().is_some_and(|steps| {
                    steps.iter().any(|step| {
                        if let Some(tool) = step["tool"].as_str() {
                            uses_foreground(driver, tool, &step["args"], headed)
                        } else {
                            step.as_object().is_some_and(|entries| {
                                entries
                                    .iter()
                                    .any(|(tool, args)| uses_foreground(driver, tool, args, headed))
                            })
                        }
                    })
                })
        }
        "click" | "double_click" | "right_click" | "drag" | "type_text" | "press_key"
        | "hotkey" | "set_value" | "scroll" | "move_cursor" | "browser_prepare"
        | "browser_click" | "browser_type" | "browser_select" | "browser_pointer" => {
            args["delivery_mode"] == "foreground"
                || args["foreground_fallback"] == true
                || args["scope"] == "desktop"
                || args["target"]["kind"] == "desktop"
                || tool == "hotkey"
                || (tool == "press_key"
                    && args["modifiers"]
                        .as_array()
                        .is_some_and(|modifiers| !modifiers.is_empty()))
        }
        _ => false,
    }
}

fn agent_action(tool: &str, args: &Value) -> bool {
    if tool == "desktop_batch" {
        return args["commands_json"]
            .as_str()
            .and_then(|commands| serde_json::from_str::<Vec<Value>>(commands).ok())
            .is_some_and(|commands| {
                commands.iter().any(|command| {
                    command["command"].as_str().is_some_and(|name| {
                        name != "batch"
                            && agent_action(
                                &format!("desktop_{}", name.replace('-', "_")),
                                &command["args"],
                            )
                    })
                })
            });
    }
    matches!(
        tool,
        "desktop_click"
            | "desktop_double_click"
            | "desktop_triple_click"
            | "desktop_right_click"
            | "desktop_type"
            | "desktop_set_value"
            | "desktop_clear"
            | "desktop_focus"
            | "desktop_select"
            | "desktop_toggle"
            | "desktop_check"
            | "desktop_uncheck"
            | "desktop_expand"
            | "desktop_collapse"
            | "desktop_scroll"
            | "desktop_scroll_to"
            | "desktop_press"
            | "desktop_key_down"
            | "desktop_key_up"
            | "desktop_hover"
            | "desktop_drag"
            | "desktop_mouse_move"
            | "desktop_mouse_click"
            | "desktop_mouse_down"
            | "desktop_mouse_up"
            | "desktop_mouse_wheel"
            | "desktop_launch"
            | "desktop_close_app"
            | "desktop_focus_window"
            | "desktop_resize_window"
            | "desktop_move_window"
            | "desktop_minimize"
            | "desktop_maximize"
            | "desktop_restore"
            | "desktop_open_system_surface"
            | "desktop_dismiss_notification"
            | "desktop_dismiss_all_notifications"
            | "desktop_notification_action"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn user_given_background_reads_or_input_when_executing_then_does_not_see_foreground_feedback() {
        for tool in [
            "get_window_state",
            "get_desktop_state",
            "list_windows",
            "set_config",
            "clipboard_write",
            "launch_app",
            "browser_prepare",
            "click",
            "type_text",
        ] {
            assert!(
                !uses_foreground(DriverId::Cua, tool, &json!({}), true),
                "{tool}"
            );
        }
        assert!(!uses_foreground(
            DriverId::Cua,
            "get_window_state",
            &json!({"delivery_mode":"foreground"}),
            true
        ));
    }

    #[test]
    fn user_given_foreground_input_or_window_changes_when_executing_then_sees_feedback() {
        for (tool, args) in [
            ("click", json!({"delivery_mode":"foreground"})),
            ("type_text", json!({"delivery_mode":"foreground"})),
            ("press_key", json!({"modifiers":["ctrl"]})),
            ("move_cursor", json!({"target":{"kind":"desktop"}})),
            ("drag", json!({"scope":"desktop"})),
            ("browser_prepare", json!({"delivery_mode":"foreground"})),
            ("bring_to_front", json!({})),
            ("set_window_frame", json!({})),
            ("run_script", json!({})),
            ("replay_trajectory", json!({})),
        ] {
            assert!(uses_foreground(DriverId::Cua, tool, &args, true), "{tool}");
        }
    }

    #[test]
    fn user_given_a_batch_when_one_step_uses_foreground_then_sees_feedback_for_the_whole_batch() {
        for steps in [
            json!([{"tool":"click","args":{"delivery_mode":"foreground"}}]),
            json!([{"press_key":{"key":"a","modifiers":["ctrl"]}}]),
        ] {
            assert!(uses_foreground(
                DriverId::Cua,
                "run_steps",
                &json!({"steps":steps}),
                true
            ));
        }
        assert!(!uses_foreground(
            DriverId::Cua,
            "run_steps",
            &json!({"steps":[{"tool":"click","args":{"delivery_mode":"background"}}]}),
            true
        ));
    }

    #[test]
    fn user_given_agent_desktop_when_using_headed_input_then_sees_feedback_but_not_for_headless_or_reads(
    ) {
        for tool in ["desktop_click", "desktop_type", "desktop_focus_window"] {
            assert!(uses_foreground(
                DriverId::AgentDesktop,
                tool,
                &json!({}),
                true
            ));
            assert!(!uses_foreground(
                DriverId::AgentDesktop,
                tool,
                &json!({}),
                false
            ));
        }
        for tool in [
            "desktop_snapshot",
            "desktop_screenshot",
            "desktop_wait",
            "desktop_clipboard_write",
            "desktop_trace_start",
        ] {
            assert!(!uses_foreground(
                DriverId::AgentDesktop,
                tool,
                &json!({}),
                true
            ));
        }
    }

    #[test]
    fn user_given_agent_batches_when_only_reading_then_stays_hidden_until_a_foreground_batch_runs()
    {
        for (commands, expected) in [
            (json!([{"command":"snapshot","args":{}}]), false),
            (json!([{"command":"focus-window","args":{}}]), true),
            (json!([{"command":"batch","args":{}}]), false),
        ] {
            assert_eq!(
                uses_foreground(
                    DriverId::AgentDesktop,
                    "desktop_batch",
                    &json!({"commands_json": commands.to_string()}),
                    true
                ),
                expected
            );
        }
    }
}
