use subtle::ConstantTimeEq;

pub fn authorized(actual: Option<&str>, expected: &str) -> bool {
    let Some(actual) = actual else { return false };
    if expected.is_empty() {
        return false;
    }
    let expected = format!("Bearer {expected}");
    actual.as_bytes().ct_eq(expected.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn requires_exact_bearer_credential() {
        assert!(authorized(Some("Bearer abc"), "abc"));
        for invalid in [Some("abc"), Some("Bearer ABC"), Some("Bearer ab"), None] {
            assert!(!authorized(invalid, "abc"));
        }
        assert!(!authorized(Some("Bearer "), ""));
    }
}
