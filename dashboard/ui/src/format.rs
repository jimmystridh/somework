use fleet_shared::timestamp_ms;

pub fn number(value: Option<f64>, precision: usize) -> String {
    value
        .map(|number| format!("{number:.precision$}"))
        .unwrap_or_else(|| "—".into())
}
pub fn bytes(value: Option<f64>) -> String {
    let Some(value) = value.filter(|value| value.is_finite() && *value >= 0.0) else {
        return "—".into();
    };
    let unit = if value < 1.0 {
        0
    } else {
        (value.log(1024.0).floor() as usize).min(4)
    };
    format!(
        "{:.*} {}",
        usize::from(unit > 1),
        value / 1024_f64.powi(unit as i32),
        ["B", "KiB", "MiB", "GiB", "TiB"][unit]
    )
}
pub fn duration(value: Option<f64>) -> String {
    let Some(seconds) = value else {
        return "—".into();
    };
    let seconds = seconds.max(0.0) as u64;
    let days = seconds / 86400;
    let hours = seconds % 86400 / 3600;
    let minutes = seconds % 3600 / 60;
    if days > 0 {
        format!("{days}d {hours}h")
    } else if hours > 0 {
        format!("{hours}h {minutes}m")
    } else {
        format!("{minutes}m")
    }
}
pub fn ago(value: Option<&str>, now: i64) -> String {
    let Some(time) = value.and_then(timestamp_ms) else {
        return "unknown".into();
    };
    let seconds = now.saturating_sub(time).max(0) as f64 / 1000.0;
    if seconds < 60.0 {
        format!("{seconds:.0}s ago")
    } else {
        format!("{} ago", duration(Some(seconds)))
    }
}

/// Seconds as a short span: `12s`, `3m 2s`, `2h 5m`, `4d 1h`; `—` when unknown.
pub fn age(value: Option<f64>) -> String {
    let Some(seconds) = value.filter(|v| v.is_finite() && *v >= 0.0) else {
        return "—".into();
    };
    let seconds = seconds as u64;
    match seconds {
        0..=59 => format!("{seconds}s"),
        60..=3599 => format!("{}m {}s", seconds / 60, seconds % 60),
        3600..=86399 => format!("{}h {}m", seconds / 3600, seconds % 3600 / 60),
        _ => format!("{}d {}h", seconds / 86400, seconds % 86400 / 3600),
    }
}
/// A whole number, or `—` when unknown.
pub fn count(value: Option<u64>) -> String {
    value.map(|n| n.to_string()).unwrap_or_else(|| "—".into())
}

/// `2026-10-10 10:42 UTC` from an RFC 3339 time; the text as it came when it is not one.
pub fn when(value: &str) -> String {
    match (value.get(..10), value.get(11..16)) {
        (Some(date), Some(time)) if timestamp_ms(value).is_some() => format!("{date} {time} UTC"),
        _ => value.to_string(),
    }
}

/// `2026-10-10 10:42 UTC · 3h 2m ago`
pub fn when_ago(value: Option<&str>, now: i64) -> String {
    match value {
        Some(time) => format!("{} · {}", when(time), ago(Some(time), now)),
        None => "—".into(),
    }
}

/// `1 revision`, `3 revisions`.
pub fn plural(count: usize, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_read_as_utc_minutes_and_unknown_text_is_left_alone() {
        assert_eq!(when("2026-10-10T10:42:13.123Z"), "2026-10-10 10:42 UTC");
        assert_eq!(when("yesterday"), "yesterday");
        assert_eq!(when(""), "");
    }

    #[test]
    fn a_time_comes_with_how_long_ago_it_was() {
        let at = timestamp_ms("2026-10-10T10:00:00.000Z").unwrap();
        assert_eq!(when_ago(Some("2026-10-10T10:00:00.000Z"), at + 3_720_000), "2026-10-10 10:00 UTC · 1h 2m ago");
        assert_eq!(when_ago(None, at), "—");
    }

    #[test]
    fn counts_are_worded() {
        assert_eq!((plural(1, "revision", "revisions"), plural(0, "revision", "revisions")), ("1 revision".to_string(), "0 revisions".to_string()));
    }
}
