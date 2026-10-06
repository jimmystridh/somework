//! A tiny reader for the Prometheus text exposition format, enough for the domain's `/metrics`.

use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq)]
pub struct Series {
    pub name: String,
    pub labels: BTreeMap<String, String>,
    pub value: f64,
}

pub fn parse(text: &str) -> Vec<Series> {
    text.lines().filter_map(line).collect()
}

fn line(line: &str) -> Option<Series> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let (head, value) = match line.find('{') {
        Some(open) => {
            let close = closing_brace(line, open)?;
            (&line[..=close], line[close + 1..].trim())
        }
        None => line.split_once(char::is_whitespace)?,
    };
    // a trailing timestamp may follow the value
    let value: f64 = value.split_whitespace().next()?.parse().ok()?;
    let (name, labels) = match head.find('{') {
        Some(open) => (&head[..open], labels(&head[open + 1..head.len() - 1])),
        None => (head, BTreeMap::new()),
    };
    Some(Series { name: name.to_string(), labels, value })
}

/// Index of the `}` that ends the label set, skipping braces inside quoted values.
fn closing_brace(line: &str, open: usize) -> Option<usize> {
    let mut quoted = false;
    let mut escaped = false;
    for (index, character) in line.char_indices().skip_while(|(index, _)| *index <= open) {
        match (quoted, escaped, character) {
            (true, true, _) => escaped = false,
            (true, false, '\\') => escaped = true,
            (_, _, '"') => quoted = !quoted,
            (false, _, '}') => return Some(index),
            _ => {}
        }
    }
    None
}

fn labels(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut rest = text;
    while let Some((key, after)) = rest.split_once("=\"") {
        let key = key.trim().trim_start_matches(',').trim();
        let mut value = String::new();
        let mut escaped = false;
        let mut end = None;
        for (index, character) in after.char_indices() {
            if escaped {
                value.push(match character {
                    'n' => '\n',
                    other => other,
                });
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                end = Some(index);
                break;
            } else {
                value.push(character);
            }
        }
        let Some(end) = end else { break };
        out.insert(key.to_string(), value);
        rest = &after[end + 1..];
    }
    out
}

#[derive(Clone, Debug, Default)]
pub struct Metrics(pub Vec<Series>);

impl Metrics {
    pub fn parse(text: &str) -> Self {
        Self(parse(text))
    }
    /// The value of a series without labels, or the sum over all of them.
    pub fn sum(&self, name: &str) -> Option<f64> {
        let values: Vec<f64> = self.0.iter().filter(|series| series.name == name).map(|series| series.value).collect();
        (!values.is_empty()).then(|| values.iter().sum())
    }
    pub fn max(&self, name: &str) -> Option<f64> {
        self.0.iter().filter(|series| series.name == name).map(|series| series.value).reduce(f64::max)
    }
    pub fn count(&self, name: &str) -> Option<u64> {
        self.sum(name).filter(|value| value.is_finite() && *value >= 0.0).map(|value| value as u64)
    }
    pub fn with_label<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Series> + 'a {
        self.0.iter().filter(move |series| series.name == name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"# HELP x
# TYPE somework_tasks_queued gauge
somework_tasks_queued 3
somework_api_requests_total{route="GET /v1/tasks/{id}",status="200"} 281
somework_api_requests_total{route="POST /v1/tasks",status="500"} 2
somework_jetstream_consumer_lag{consumer="inbox_agent~2fmanager",stream="SOMEWORK_INBOX"} 7
odd{label="has } brace and \"quote\""} 1.5 1790000000000
"#;

    #[test]
    fn reads_plain_labelled_and_awkward_series() {
        let metrics = Metrics::parse(SAMPLE);
        assert_eq!(metrics.count("somework_tasks_queued"), Some(3));
        assert_eq!(metrics.sum("somework_api_requests_total"), Some(283.0));
        let lag: Vec<_> = metrics.with_label("somework_jetstream_consumer_lag").collect();
        assert_eq!(lag[0].labels["consumer"], "inbox_agent~2fmanager");
        assert_eq!(lag[0].value, 7.0);
        let odd = metrics.with_label("odd").next().unwrap();
        assert_eq!(odd.labels["label"], "has } brace and \"quote\"");
        assert_eq!(odd.value, 1.5);
    }

    #[test]
    fn missing_series_are_none_not_zero() {
        assert_eq!(Metrics::parse(SAMPLE).count("somework_outbox_dead"), None);
    }
}
