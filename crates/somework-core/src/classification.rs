use serde::{Deserialize, Serialize};

/// Ordered classification levels of a trust domain, lowest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClassificationScale(pub Vec<String>);

impl Default for ClassificationScale {
    fn default() -> Self {
        Self(["public", "internal", "confidential", "restricted"].map(String::from).to_vec())
    }
}

impl ClassificationScale {
    pub fn rank(&self, level: &str) -> Option<usize> {
        self.0.iter().position(|l| l == level)
    }

    /// `true` when `actor_max` may handle data classified as `resource`. Unknown levels fail closed.
    pub fn permits(&self, actor_max: &str, resource: &str) -> bool {
        match (self.rank(actor_max), self.rank(resource)) {
            (Some(a), Some(r)) => a >= r,
            _ => false,
        }
    }

    pub fn is_known(&self, level: &str) -> bool {
        self.rank(level).is_some()
    }

    pub fn min<'a>(&self, a: &'a str, b: &'a str) -> &'a str {
        match (self.rank(a), self.rank(b)) {
            (Some(x), Some(y)) => {
                if x <= y {
                    a
                } else {
                    b
                }
            }
            (Some(_), None) => b,
            _ => a,
        }
    }
}

/// Minimal glob: `*` matches any run of characters (including `/` and `.`).
pub fn glob_match(pattern: &str, value: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == value;
    }
    let mut rest = value;
    for (i, part) in parts.iter().enumerate() {
        if i == 0 {
            match rest.strip_prefix(part) {
                Some(r) => rest = r,
                None => return false,
            }
        } else if i == parts.len() - 1 {
            return rest.ends_with(part);
        } else {
            match rest.find(part) {
                Some(pos) => rest = &rest[pos + part.len()..],
                None => return false,
            }
        }
    }
    true
}

pub fn any_glob(patterns: &[String], value: &str) -> bool {
    patterns.iter().any(|p| glob_match(p, value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordering() {
        let scale = ClassificationScale::default();
        assert!(scale.permits("confidential", "internal"));
        assert!(scale.permits("internal", "internal"));
        assert!(!scale.permits("internal", "restricted"));
        assert!(!scale.permits("internal", "nonsense"));
        assert!(!scale.permits("nonsense", "public"));
    }

    #[test]
    fn globbing() {
        assert!(glob_match("code.*", "code.review"));
        assert!(!glob_match("code.*", "deployment.execute"));
        assert!(glob_match("artifact://development/pr729/*", "artifact://development/pr729/x/1"));
        assert!(glob_match("*", "anything"));
        assert!(glob_match("a*c", "abc"));
        assert!(!glob_match("a*c", "abd"));
        assert!(glob_match("exact", "exact"));
        assert!(!glob_match("exact", "exactly"));
    }
}
