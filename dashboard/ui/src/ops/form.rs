//! The setup form as an editor handles it: what the role's defaults fill in, what counts as a change, and the checkbox lists.

use fleet_shared::{
    operations::{ApprovalPatternSetting, ModelChoice, RoleDefaults, SetupForm},
    somework::ApprovalPattern,
};
use std::collections::BTreeSet;

/// `provider/modelId`, the way the agent's profile names a model.
pub fn model_text(model: &ModelChoice) -> String {
    format!("{}/{}", model.provider, model.model_id)
}

pub fn parse_model(text: &str) -> Option<ModelChoice> {
    let (provider, model_id) = text.trim().split_once('/')?;
    (!provider.is_empty() && !model_id.is_empty()).then(|| ModelChoice { provider: provider.into(), model_id: model_id.into() })
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
        model: form.model.clone(),
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
        let model = parse_model("openai-codex/gpt-5.5").unwrap();
        assert_eq!((model.provider.as_str(), model.model_id.as_str()), ("openai-codex", "gpt-5.5"));
        assert_eq!(model_text(&model), "openai-codex/gpt-5.5");
        assert_eq!(parse_model("noslash"), None);
        assert_eq!(parse_model("/id"), None);
        assert_eq!(parse_model("a/b/c").map(|model| model.model_id), Some("b/c".to_string()), "only the first slash splits");
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
        let draft = SetupForm { instructions: Some("x".into()), model: parse_model("a/b"), library_skills: vec!["z".into(), "a".into()], mcp: vec!["docs".into()], ..Default::default() };
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
