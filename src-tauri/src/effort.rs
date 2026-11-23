//! How hard the model should think, expressed once and translated four ways.
//!
//! Every provider Atimo speaks to exposes this knob, and no two spell it the
//! same way — one takes a JSON object, one takes a CLI flag, one takes a config
//! override, and one only has an on/off switch. Rather than let four adapters
//! each invent their own vocabulary, the app has one scale and the translation
//! lives here, in one file you can read end to end.
//!
//! The scale is deliberately shorter than the longest provider's. Codex accepts
//! seven levels (`none` … `max`); offering all seven would mean four of them
//! silently collapsing to the same thing everywhere else. Five levels plus
//! "leave it alone" is the most that means something on every provider.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    /// Send nothing and let the provider pick. The default, and the behaviour
    /// every turn had before this setting existed — so an app that has never
    /// touched the control sends byte-identical requests to before.
    #[default]
    Auto,
    /// Answer without a scratchpad. Not every provider can do this; see
    /// `claude_flag`.
    Off,
    Low,
    Medium,
    High,
    Max,
}

impl Effort {
    fn level(self) -> Option<&'static str> {
        match self {
            Effort::Auto | Effort::Off => None,
            Effort::Low => Some("low"),
            Effort::Medium => Some("medium"),
            Effort::High => Some("high"),
            Effort::Max => Some("max"),
        }
    }

    /// OpenRouter's `reasoning` object.
    ///
    /// Its ceiling is `xhigh`, not `max`, so the top of our scale maps there.
    /// Turning reasoning off is `enabled: false` rather than an effort value —
    /// there is no "zero effort" level in their vocabulary.
    pub fn openrouter(self) -> Option<Value> {
        match self {
            Effort::Auto => None,
            Effort::Off => Some(json!({ "enabled": false })),
            Effort::Max => Some(json!({ "effort": "xhigh" })),
            other => other.level().map(|level| json!({ "effort": level })),
        }
    }

    /// Z.AI's `thinking` object, which is a switch and not a dial.
    ///
    /// GLM has no effort levels, so every "on" level maps to the same request.
    /// The UI still shows the levels rather than hiding them per provider: a
    /// control that appears and disappears as you change model is worse than
    /// one whose finer settings are a no-op on some of them, and the tooltip
    /// says so.
    pub fn zai(self) -> Option<Value> {
        match self {
            Effort::Auto => None,
            Effort::Off => Some(json!({ "type": "disabled" })),
            _ => Some(json!({ "type": "enabled" })),
        }
    }

    /// Claude Code's `--effort` flag: `low`, `medium`, `high`, `xhigh`, `max`.
    ///
    /// There is no way to switch thinking off, so `Off` clamps to the floor
    /// rather than being dropped. Dropping it would be worse: the user asked
    /// for the fastest answer available and would silently get the CLI's
    /// default instead, which may be several levels above it.
    pub fn claude_flag(self) -> Option<&'static str> {
        match self {
            Effort::Auto => None,
            Effort::Off => Some("low"),
            other => other.level(),
        }
    }

    /// Codex's `model_reasoning_effort` config override. Its accepted set is
    /// `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` — verified
    /// against the API, which names them all when rejecting an invalid one.
    pub fn codex_value(self) -> Option<&'static str> {
        match self {
            Effort::Auto => None,
            Effort::Off => Some("none"),
            other => other.level(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire names are shared with `Effort` in `src/lib/effort.ts`, and
    /// nothing in either type system spans that gap.
    #[test]
    fn effort_names_match_the_typescript_union() {
        for (value, name) in [
            (Effort::Auto, "auto"),
            (Effort::Off, "off"),
            (Effort::Low, "low"),
            (Effort::Medium, "medium"),
            (Effort::High, "high"),
            (Effort::Max, "max"),
        ] {
            assert_eq!(serde_json::to_value(value).unwrap(), json!(name));
        }
    }

    /// The whole point of `Auto`: a user who never touches the control must
    /// keep getting exactly the request they got before it shipped.
    #[test]
    fn auto_adds_nothing_to_any_provider() {
        assert_eq!(Effort::Auto.openrouter(), None);
        assert_eq!(Effort::Auto.zai(), None);
        assert_eq!(Effort::Auto.claude_flag(), None);
        assert_eq!(Effort::Auto.codex_value(), None);
    }

    #[test]
    fn off_disables_where_it_can_and_clamps_where_it_cannot() {
        assert_eq!(Effort::Off.openrouter(), Some(json!({ "enabled": false })));
        assert_eq!(Effort::Off.zai(), Some(json!({ "type": "disabled" })));
        assert_eq!(Effort::Off.codex_value(), Some("none"));
        // Claude Code cannot switch thinking off. Clamping to the floor honours
        // "as fast as possible"; dropping the flag would hand back the CLI's
        // own default, which can be several levels higher.
        assert_eq!(Effort::Off.claude_flag(), Some("low"));
    }

    #[test]
    fn the_top_of_the_scale_uses_each_providers_own_ceiling() {
        // OpenRouter tops out at `xhigh`; sending `max` would be a 400.
        assert_eq!(Effort::Max.openrouter(), Some(json!({ "effort": "xhigh" })));
        assert_eq!(Effort::Max.claude_flag(), Some("max"));
        assert_eq!(Effort::Max.codex_value(), Some("max"));
    }

    /// GLM has no levels. Every "on" setting has to produce the same request,
    /// or the app would be sending a field the gateway rejects.
    #[test]
    fn zai_collapses_every_on_level_to_one_switch() {
        let on = Some(json!({ "type": "enabled" }));
        for level in [Effort::Low, Effort::Medium, Effort::High, Effort::Max] {
            assert_eq!(level.zai(), on);
        }
    }
}
