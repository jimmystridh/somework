//! The fleet and SomeWork samples the older sections show, refreshed every 15 seconds for the whole app, and the clock the pages measure
//! ages against. Operations' own data is loaded by the pages that use it.

use dioxus::prelude::*;
use fleet_shared::{Fleet, somework::SomeWork, timestamp_ms};
use gloo_timers::future::TimeoutFuture;

#[derive(Clone, Copy)]
pub struct Live {
    pub fleet: Signal<Option<Fleet>>,
    pub fleet_failed: Signal<bool>,
    pub loading: Signal<bool>,
    pub somework: Signal<Option<SomeWork>>,
    pub somework_failed: Signal<bool>,
    pub now: Signal<i64>,
}

async fn fetch<T: serde::de::DeserializeOwned>(path: &str) -> Result<T, ()> {
    let response = gloo_net::http::Request::get(path).send().await.map_err(|_| ())?;
    if !response.ok() {
        return Err(());
    }
    response.json::<T>().await.map_err(|_| ())
}

impl Live {
    pub async fn refresh(mut self) {
        match fetch::<SomeWork>("/fleet/api/somework").await {
            Ok(data) => {
                self.somework.set(Some(data));
                self.somework_failed.set(false);
            }
            Err(()) => self.somework_failed.set(true),
        }
        self.loading.set(true);
        match fetch::<Fleet>("/fleet/api/fleet").await {
            Ok(data) => {
                self.fleet.set(Some(data));
                self.fleet_failed.set(false);
            }
            Err(()) => self.fleet_failed.set(true),
        }
        self.loading.set(false);
    }

    /// The hypervisor sample is current, and no read failed.
    pub fn connected(&self) -> bool {
        let time = *self.now.read();
        !*self.fleet_failed.read()
            && self.fleet.read().as_ref().is_some_and(|data| data.error.is_none() && data.observed_at.as_deref().and_then(timestamp_ms).is_some_and(|sample| time - sample <= 60_000))
    }
}

pub fn use_live_provider() -> Live {
    let live = Live {
        fleet: use_signal(|| None::<Fleet>),
        fleet_failed: use_signal(|| false),
        loading: use_signal(|| false),
        somework: use_signal(|| None::<SomeWork>),
        somework_failed: use_signal(|| false),
        now: use_signal(|| js_sys::Date::now() as i64),
    };
    use_context_provider(|| live);
    use_future(move || async move {
        loop {
            live.refresh().await;
            TimeoutFuture::new(15000).await;
        }
    });
    let mut now = live.now;
    use_future(move || async move {
        loop {
            TimeoutFuture::new(1000).await;
            now.set(js_sys::Date::now() as i64);
        }
    });
    live
}
