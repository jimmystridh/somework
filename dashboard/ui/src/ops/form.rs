//! The setup form as an editor handles it: what the role's defaults fill in, what counts as a change, and the checkbox lists.

use fleet_shared::{
    operations::{ApprovalPatternSetting, Effort, ModelChoice, RoleDefaults, SetupForm},
    somework::ApprovalPattern,
};
use std::collections::BTreeSet;

/// Splits `provider/modelId`, the way the agent's profile names a model: only the first slash splits.
pub fn split_model(text: &str) -> Option<(&str, &str)> {
    let (provider, model_id) = text.trim().split_once('/')?;
    (!provider.is_empty() && !model_id.is_empty()).then_some((provider, model_id))
}

/// The providers of the models an agent allows, in the order it lists them, each once.
pub fn allowed_providers(allowed: &[String]) -> Vec<String> {
    let mut providers: Vec<String> = Vec::new();
    for (provider, _) in allowed.iter().filter_map(|text| split_model(text)) {
        if !providers.iter().any(|known| known == provider) {
            providers.push(provider.to_string());
        }
    }
    providers
}

/// The model ids an agent allows for one provider.
pub fn allowed_model_ids(allowed: &[String], provider: &str) -> Vec<String> {
    allowed.iter().filter_map(|text| split_model(text)).filter(|(name, _)| *name == provider).map(|(_, model_id)| model_id.to_string()).collect()
}

/// A part of the model set by something above the agent's own setup, and what it comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Inherited {
    Fleet,
    Environment,
}

impl Inherited {
    pub fn text(self) -> &'static str {
        match self {
            Inherited::Fleet => "the fleet's model",
            Inherited::Environment => "this agent's environment",
        }
    }
}

/// What the blank fields of an agent's model take: the fleet's value where it sets one, else the agent's environment.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InheritedModel {
    pub provider: Option<(String, Inherited)>,
    pub model_id: Option<(String, Inherited)>,
    pub effort: Option<(Effort, Inherited)>,
}

pub fn inherited_model(fleet: Option<&ModelChoice>, defaults: Option<&RoleDefaults>) -> InheritedModel {
    let environment = defaults.and_then(|defaults| split_model(&defaults.model));
    let environment_effort = defaults.and_then(|defaults| defaults.effort.as_deref()).and_then(Effort::parse);
    let pick = |from_fleet: Option<String>, from_environment: Option<&str>| match (from_fleet, from_environment) {
        (Some(value), _) => Some((value, Inherited::Fleet)),
        (None, Some(value)) => Some((value.to_string(), Inherited::Environment)),
        (None, None) => None,
    };
    InheritedModel {
        provider: pick(fleet.and_then(|model| model.provider.clone()), environment.map(|(provider, _)| provider)),
        model_id: pick(fleet.and_then(|model| model.model_id.clone()), environment.map(|(_, model_id)| model_id)),
        effort: match (fleet.and_then(|model| model.effort), environment_effort) {
            (Some(effort), _) => Some((effort, Inherited::Fleet)),
            (None, Some(effort)) => Some((effort, Inherited::Environment)),
            (None, None) => None,
        },
    }
}

/// The text of the blank choice of a select: what it inherits, when that is known.
pub fn inherit_label(value: Option<(&str, Inherited)>) -> String {
    match value {
        Some((value, source)) => format!("Inherit ({value}, from {})", source.text()),
        None => "Inherit".to_string(),
    }
}

/// The hint under a control: what a blank field takes.
pub fn inherit_hint(part: &str, value: Option<(&str, Inherited)>, nothing: &str) -> String {
    match value {
        Some((value, source)) => format!("Blank: the {part} is {value}, from {}.", source.text()),
        None => format!("Blank: {nothing}"),
    }
}

/// The model after one part is chosen; an empty text inherits that part, and a model with no part left is no model.
fn with_part(model: Option<&ModelChoice>, change: impl FnOnce(&mut ModelChoice)) -> Option<ModelChoice> {
    let mut next = model.cloned().unwrap_or_default();
    change(&mut next);
    (!next.is_empty()).then_some(next)
}

fn named(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// The model after a provider is chosen. A model id that was chosen too, and that the agent does not allow for the new provider, goes with the old provider.
pub fn with_provider(model: Option<&ModelChoice>, provider: &str, allowed: &[String]) -> Option<ModelChoice> {
    with_part(model, |next| {
        next.provider = named(provider);
        let belongs = match (&next.provider, &next.model_id) {
            (Some(provider), Some(model_id)) => allowed.is_empty() || allowed_model_ids(allowed, provider).contains(model_id),
            _ => true,
        };
        if !belongs {
            next.model_id = None;
        }
    })
}

pub fn with_model_id(model: Option<&ModelChoice>, model_id: &str) -> Option<ModelChoice> {
    with_part(model, |next| next.model_id = named(model_id))
}

pub fn with_effort(model: Option<&ModelChoice>, effort: &str) -> Option<ModelChoice> {
    with_part(model, |next| next.effort = Effort::parse(effort.trim()))
}

/// What the fleet page's three fields hold for a saved model: provider, model id and effort as text, empty where the part inherits.
pub fn model_texts(model: Option<&ModelChoice>) -> [String; 3] {
    [
        model.and_then(|model| model.provider.clone()).unwrap_or_default(),
        model.and_then(|model| model.model_id.clone()).unwrap_or_default(),
        model.and_then(|model| model.effort).map(|effort| effort.as_str().to_string()).unwrap_or_default(),
    ]
}

/// The model the three fields of the fleet page stand for: none while all are empty.
pub fn model_from_texts(texts: &[String; 3]) -> Option<ModelChoice> {
    let model = ModelChoice { provider: named(&texts[0]), model_id: named(&texts[1]), effort: Effort::parse(texts[2].trim()) };
    (!model.is_empty()).then_some(model)
}

pub fn pattern_setting(pattern: &ApprovalPattern) -> ApprovalPatternSetting {
    ApprovalPatternSetting { pattern: pattern.pattern.clone(), reason: pattern.reason.clone() }
}

/// The patterns an editor shows: the form's own list, or the role's list when the form keeps the role's.
pub fn shown_patterns(form: &SetupForm, defaults: Option<&RoleDefaults>) -> Vec<ApprovalPatternSetting> {
    form.approval_patterns.clone().unwrap_or_else(|| defaults.map(|defaults| defaults.approval_patterns.iter().map(pattern_setting).collect()).unwrap_or_default())
}

/// The repository skills an editor shows as allowed: the form's list, or the role's.
pub fn shown_repository_skills(form: &SetupForm, defaults: Option<&RoleDefaults>) -> Vec<String> {
    form.repository_skills.clone().unwrap_or_else(|| defaults.map(|defaults| defaults.repository_skills.clone()).unwrap_or_default())
}

fn same_patterns(list: &[ApprovalPatternSetting], defaults: &[ApprovalPattern]) -> bool {
    list.len() == defaults.len() && list.iter().zip(defaults).all(|(setting, default)| setting.pattern == default.pattern && setting.reason.trim() == default.reason.trim())
}

fn same_names(list: &[String], defaults: &[String]) -> bool {
    list.iter().collect::<BTreeSet<_>>() == defaults.iter().collect::<BTreeSet<_>>()
}

fn sorted(names: &[String]) -> Vec<String> {
    names.iter().cloned().collect::<BTreeSet<_>>().into_iter().collect()
}

/// A form in the shape the server stores it, so two forms can be compared: empty text and empty overlays are gone, names are sorted and
/// unique, and a list equal to the role's own is the same as "keep the role's".
pub fn canonical(form: &SetupForm, defaults: Option<&RoleDefaults>) -> SetupForm {
    let approval_patterns = form.approval_patterns.as_ref().map(|list| list.iter().map(|item| ApprovalPatternSetting { pattern: item.pattern.clone(), reason: item.reason.trim().to_string() }).collect::<Vec<_>>());
    SetupForm {
        instructions: form.instructions.as_deref().filter(|text| !text.trim().is_empty()).map(|text| text.trim_end().to_string()),
        disable_global_prompt: form.disable_global_prompt,
        model: form.model.clone().filter(|model| !model.is_empty()),
        approval_patterns: approval_patterns.filter(|list| defaults.is_none_or(|defaults| !same_patterns(list, &defaults.approval_patterns))),
        repository_skills: form.repository_skills.as_ref().map(|names| sorted(names)).filter(|names| defaults.is_none_or(|defaults| !same_names(names, &defaults.repository_skills))),
        library_skills: sorted(&form.library_skills),
        overlays: form.overlays.iter().filter(|(_, text)| !text.trim().is_empty()).map(|(name, text)| (name.clone(), text.clone())).collect(),
        mcp: sorted(&form.mcp),
    }
}

pub fn is_dirty(saved: &SetupForm, draft: &SetupForm, defaults: Option<&RoleDefaults>) -> bool {
    canonical(saved, defaults) != canonical(draft, defaults)
}

/// Which parts of the form differ, named for people: shown next to the save button.
pub fn changed_parts(saved: &SetupForm, draft: &SetupForm, defaults: Option<&RoleDefaults>) -> Vec<&'static str> {
    let (saved, draft) = (canonical(saved, defaults), canonical(draft, defaults));
    let mut parts = Vec::new();
    for (name, changed) in [
        ("operator instructions", saved.instructions != draft.instructions),
        ("global prompt", saved.disable_global_prompt != draft.disable_global_prompt),
        ("model", saved.model != draft.model),
        ("approval patterns", saved.approval_patterns != draft.approval_patterns),
        ("repository skills", saved.repository_skills != draft.repository_skills),
        ("library skills", saved.library_skills != draft.library_skills),
        ("skill overlays", saved.overlays != draft.overlays),
        ("MCP servers", saved.mcp != draft.mcp),
    ] {
        if changed {
            parts.push(name);
        }
    }
    parts
}

/// Adds or removes a name, keeping the list free of repeats.
pub fn with_name(list: &[String], name: &str, on: bool) -> Vec<String> {
    let mut names: Vec<String> = list.iter().filter(|existing| *existing != name).cloned().collect();
    if on {
        names.push(name.to_string());
    }
    names
}

/// The repository skill list after one box was ticked or cleared; a list that becomes the role's own is stored as `None`.
pub fn toggle_repository_skill(form: &SetupForm, defaults: Option<&RoleDefaults>, name: &str, on: bool) -> Option<Vec<String>> {
    let next = with_name(&shown_repository_skills(form, defaults), name, on);
    defaults.filter(|defaults| same_names(&next, &defaults.repository_skills)).map_or(Some(next), |_| None)
}

/// Replaces the pattern at `index` (or adds one when `index` is past the end), turning "keep the role's" into the role's list with that change.
pub fn with_pattern(form: &SetupForm, defaults: Option<&RoleDefaults>, index: usize, item: ApprovalPatternSetting) -> Vec<ApprovalPatternSetting> {
    let mut list = shown_patterns(form, defaults);
    match list.get_mut(index) {
        Some(slot) => *slot = item,
        None => list.push(item),
    }
    list
}

pub fn without_pattern(form: &SetupForm, defaults: Option<&RoleDefaults>, index: usize) -> Vec<ApprovalPatternSetting> {
    let mut list = shown_patterns(form, defaults);
    if index < list.len() {
        list.remove(index);
    }
    list
}

/// The skills an overlay can belong to: the repository skills the role allows and any the form already has an overlay for.
pub fn overlay_names(form: &SetupForm, defaults: Option<&RoleDefaults>) -> Vec<String> {
    let mut names: BTreeSet<String> = shown_repository_skills(form, defaults).into_iter().collect();
    names.extend(defaults.iter().flat_map(|defaults| defaults.repository_skills.iter().cloned()));
    names.extend(form.overlays.keys().cloned());
    names.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defaults() -> RoleDefaults {
        RoleDefaults {
            role: "developer".into(),
            approval_patterns: vec![ApprovalPattern { pattern: "git push".into(), reason: "publishes work".into() }, ApprovalPattern { pattern: "rm -rf".into(), reason: "deletes".into() }],
            repository_skills: vec!["review".into(), "tdd".into()],
            allowed_models: vec!["anthropic/claude".into()],
            ..Default::default()
        }
    }

    fn setting(pattern: &str, reason: &str) -> ApprovalPatternSetting {
        ApprovalPatternSetting { pattern: pattern.into(), reason: reason.into() }
    }

    #[test]
    fn models_are_provider_slash_id() {
        assert_eq!(split_model("openai-codex/gpt-5.5"), Some(("openai-codex", "gpt-5.5")));
        assert_eq!(split_model("noslash"), None);
        assert_eq!(split_model("/id"), None);
        assert_eq!(split_model("a/b/c"), Some(("a", "b/c")), "only the first slash splits");
    }

    fn allowed() -> Vec<String> {
        ["openai-codex/gpt-5.5", "openai-codex/gpt-6.1-sol", "opencode-go/kimi-k3"].map(String::from).to_vec()
    }

    fn choice(provider: Option<&str>, model_id: Option<&str>, effort: Option<Effort>) -> ModelChoice {
        ModelChoice { provider: provider.map(str::to_string), model_id: model_id.map(str::to_string), effort }
    }

    #[test]
    fn the_providers_and_models_an_agent_allows_are_offered_one_list_each() {
        assert_eq!(allowed_providers(&allowed()), ["openai-codex", "opencode-go"]);
        assert_eq!(allowed_model_ids(&allowed(), "openai-codex"), ["gpt-5.5", "gpt-6.1-sol"]);
        assert_eq!(allowed_model_ids(&allowed(), "nobody"), Vec::<String>::new());
        assert!(allowed_providers(&[]).is_empty());
    }

    #[test]
    fn each_part_of_the_model_is_chosen_alone_and_a_blank_one_inherits() {
        let mut model = None;
        model = with_effort(model.as_ref(), "high");
        assert_eq!(model, Some(choice(None, None, Some(Effort::High))));
        model = with_provider(model.as_ref(), "openai-codex", &allowed());
        model = with_model_id(model.as_ref(), "gpt-6.1-sol");
        assert_eq!(model, Some(choice(Some("openai-codex"), Some("gpt-6.1-sol"), Some(Effort::High))));
        model = with_effort(model.as_ref(), "");
        assert_eq!(model, Some(choice(Some("openai-codex"), Some("gpt-6.1-sol"), None)));
        model = with_model_id(model.as_ref(), " ");
        model = with_provider(model.as_ref(), "", &allowed());
        assert_eq!(model, None, "a model with every part blank is no model");
        assert_eq!(with_effort(None, "extreme"), None, "a level that does not exist is not chosen");
    }

    #[test]
    fn changing_the_provider_drops_a_model_id_the_agent_does_not_allow_for_it() {
        let model = choice(Some("openai-codex"), Some("gpt-6.1-sol"), Some(Effort::Low));
        assert_eq!(with_provider(Some(&model), "opencode-go", &allowed()), Some(choice(Some("opencode-go"), None, Some(Effort::Low))));
        assert_eq!(with_provider(Some(&model), "openai-codex", &allowed()), Some(model.clone()));
        assert_eq!(with_provider(Some(&model), "opencode-go", &[]), Some(choice(Some("opencode-go"), Some("gpt-6.1-sol"), Some(Effort::Low))), "an agent that lists nothing gives no ground to drop it");
    }

    #[test]
    fn blank_fields_take_the_fleets_value_and_then_the_agents_environment() {
        let roles = RoleDefaults { model: "openai-codex/gpt-5.5".into(), effort: Some("medium".into()), ..Default::default() };
        let none = inherited_model(None, Some(&roles));
        assert_eq!(none.provider, Some(("openai-codex".to_string(), Inherited::Environment)));
        assert_eq!(none.model_id, Some(("gpt-5.5".to_string(), Inherited::Environment)));
        assert_eq!(none.effort, Some((Effort::Medium, Inherited::Environment)));

        let fleet = choice(None, Some("gpt-6.1-sol"), Some(Effort::High));
        let mixed = inherited_model(Some(&fleet), Some(&roles));
        assert_eq!(mixed.provider, Some(("openai-codex".to_string(), Inherited::Environment)), "the fleet leaves the provider to the environment");
        assert_eq!(mixed.model_id, Some(("gpt-6.1-sol".to_string(), Inherited::Fleet)));
        assert_eq!(mixed.effort, Some((Effort::High, Inherited::Fleet)));

        assert_eq!(inherited_model(None, None), InheritedModel::default(), "an agent that did not answer: nothing is known");
        let without_effort = inherited_model(None, Some(&RoleDefaults { model: "a/b".into(), ..Default::default() }));
        assert_eq!(without_effort.effort, None);
    }

    #[test]
    fn the_hints_say_what_a_blank_field_takes() {
        assert_eq!(inherit_label(Some(("gpt-6.1-sol", Inherited::Fleet))), "Inherit (gpt-6.1-sol, from the fleet's model)");
        assert_eq!(inherit_label(None), "Inherit");
        assert_eq!(inherit_hint("effort", Some(("high", Inherited::Environment)), "x"), "Blank: the effort is high, from this agent's environment.");
        assert_eq!(inherit_hint("effort", None, "no effort is set."), "Blank: no effort is set.");
    }

    #[test]
    fn the_fleet_pages_three_fields_make_a_model_when_any_is_filled() {
        assert_eq!(model_from_texts(&[String::new(), "  ".into(), String::new()]), None);
        let typed = ["openai-codex".to_string(), " gpt-6.1-sol ".to_string(), "high".to_string()];
        let model = model_from_texts(&typed).unwrap();
        assert_eq!(model, choice(Some("openai-codex"), Some("gpt-6.1-sol"), Some(Effort::High)));
        assert_eq!(model_texts(Some(&model)), ["openai-codex", "gpt-6.1-sol", "high"]);
        assert_eq!(model_texts(None), ["", "", ""]);
        assert_eq!(model_from_texts(&[String::new(), String::new(), "max".into()]), Some(choice(None, None, Some(Effort::Max))));
    }

    #[test]
    fn the_editor_shows_the_roles_patterns_until_the_form_has_its_own() {
        let roles = defaults();
        let keep = SetupForm::default();
        assert_eq!(shown_patterns(&keep, Some(&roles)), vec![setting("git push", "publishes work"), setting("rm -rf", "deletes")]);
        let own = SetupForm { approval_patterns: Some(vec![setting("curl", "network")]), ..Default::default() };
        assert_eq!(shown_patterns(&own, Some(&roles)), vec![setting("curl", "network")]);
        assert!(shown_patterns(&keep, None).is_empty());
    }

    #[test]
    fn editing_one_pattern_starts_from_the_roles_list() {
        let roles = defaults();
        let list = with_pattern(&SetupForm::default(), Some(&roles), 1, setting("rm -rf /", "deletes everything"));
        assert_eq!(list, vec![setting("git push", "publishes work"), setting("rm -rf /", "deletes everything")]);
        let added = with_pattern(&SetupForm::default(), Some(&roles), 2, setting("curl", "network"));
        assert_eq!(added.len(), 3);
        assert_eq!(without_pattern(&SetupForm::default(), Some(&roles), 0), vec![setting("rm -rf", "deletes")]);
        assert_eq!(without_pattern(&SetupForm::default(), Some(&roles), 9).len(), 2, "a row that is not there changes nothing");
    }

    #[test]
    fn a_list_equal_to_the_roles_own_is_not_a_change() {
        let roles = defaults();
        let saved = SetupForm::default();
        let same = SetupForm { approval_patterns: Some(vec![setting("git push", "publishes work "), setting("rm -rf", "deletes")]), repository_skills: Some(vec!["tdd".into(), "review".into()]), ..Default::default() };
        assert!(!is_dirty(&saved, &same, Some(&roles)));
        assert!(changed_parts(&saved, &same, Some(&roles)).is_empty());
        let fewer = SetupForm { approval_patterns: Some(vec![]), ..Default::default() };
        assert!(is_dirty(&saved, &fewer, Some(&roles)), "no command needing approval is a real change from the role's list");
        assert_eq!(canonical(&fewer, Some(&roles)).approval_patterns, Some(vec![]));
    }

    #[test]
    fn whitespace_and_empty_overlays_are_not_changes() {
        let saved = SetupForm { instructions: Some("Be brief".into()), ..Default::default() };
        let draft = SetupForm { instructions: Some("Be brief\n\n".into()), overlays: [("review".to_string(), "  ".to_string())].into(), ..Default::default() };
        assert!(!is_dirty(&saved, &draft, None));
        let cleared = SetupForm { instructions: Some(" ".into()), ..Default::default() };
        assert_eq!(canonical(&cleared, None).instructions, None);
    }

    #[test]
    fn changed_parts_are_named_for_people() {
        let saved = SetupForm::default();
        let draft = SetupForm { instructions: Some("x".into()), model: Some(choice(Some("a"), Some("b"), None)), library_skills: vec!["z".into(), "a".into()], mcp: vec!["docs".into()], ..Default::default() };
        assert_eq!(changed_parts(&saved, &draft, None), ["operator instructions", "model", "library skills", "MCP servers"]);
        assert_eq!(canonical(&draft, None).library_skills, ["a", "z"]);
    }

    #[test]
    fn ticking_a_repository_skill_off_and_on_ends_where_it_started() {
        let roles = defaults();
        let mut form = SetupForm::default();
        form.repository_skills = toggle_repository_skill(&form, Some(&roles), "tdd", false);
        assert_eq!(form.repository_skills.as_deref(), Some(&["review".to_string()][..]));
        form.repository_skills = toggle_repository_skill(&form, Some(&roles), "tdd", true);
        assert_eq!(form.repository_skills, None, "the role's own list is stored as keeping it");
    }

    #[test]
    fn names_are_added_once_and_removed() {
        let list = vec!["a".to_string(), "b".to_string()];
        assert_eq!(with_name(&list, "b", true), ["a", "b"]);
        assert_eq!(with_name(&list, "c", true), ["a", "b", "c"]);
        assert_eq!(with_name(&list, "a", false), ["b"]);
    }

    #[test]
    fn overlays_can_be_written_for_every_skill_the_role_has_and_for_those_that_already_have_one() {
        let roles = defaults();
        let form = SetupForm { repository_skills: Some(vec!["review".into()]), overlays: [("old".to_string(), "x".to_string())].into(), ..Default::default() };
        assert_eq!(overlay_names(&form, Some(&roles)), ["old", "review", "tdd"]);
    }
}
