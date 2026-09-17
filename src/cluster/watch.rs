//! List-then-watch, the way a Kubernetes informer does it.
//!
//! The browser receives one `SYNC` with the full list, then `ADDED`,
//! `MODIFIED` and `DELETED` as they happen. An expired resource version (`410
//! Gone`) is handled here by listing again, so a subscriber never has to know
//! the watch was restarted — it just receives a fresh `SYNC`.

use std::time::Duration;

use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};

use super::paths::{ResourceRef, with_query};
use super::{ApiError, Kube, slim};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchParams {
    #[serde(flatten)]
    pub target: ResourceRef,
    #[serde(default)]
    pub label_selector: Option<String>,
    #[serde(default)]
    pub field_selector: Option<String>,
}

enum Outcome {
    Relist,
    Stop,
}

/// Run until `emit` reports the subscriber has gone, or the watch fails for a
/// reason retrying cannot fix (forbidden, not found).
pub async fn run(
    kube: Kube,
    params: WatchParams,
    emit: impl Fn(Value) -> bool + Send + Sync,
) -> Result<(), ApiError> {
    let mut collection = params.target.clone();
    let mut field_selector = params.field_selector.clone();
    if let Some(name) = collection.name.take() {
        super::paths::segment("name", &name)?;
        let by_name = format!("metadata.name={name}");
        field_selector = Some(match field_selector {
            Some(existing) if !existing.is_empty() => format!("{existing},{by_name}"),
            _ => by_name,
        });
    }
    collection.subresource = None;
    let path = collection.path()?;

    let mut failures = 0u32;
    loop {
        let (items, mut version) = match list(&kube, &path, &params.label_selector, &field_selector).await {
            Ok(listed) => listed,
            Err(e) if e.status == 403 || e.status == 404 || e.status == 400 => return Err(e),
            Err(e) => {
                failures += 1;
                if !emit(json!({ "type": "ERROR", "error": e })) {
                    return Ok(());
                }
                tokio::time::sleep(backoff(failures)).await;
                continue;
            }
        };

        if !emit(json!({ "type": "SYNC", "items": items, "resourceVersion": version })) {
            return Ok(());
        }

        match watch(&kube, &path, &params, &field_selector, &mut version, &emit, &mut failures).await {
            Ok(Outcome::Relist) => continue,
            Ok(Outcome::Stop) => return Ok(()),
            Err(e) => return Err(e),
        }
    }
}

fn backoff(failures: u32) -> Duration {
    Duration::from_secs((1u64 << failures.min(5)).min(30))
}

async fn list(
    kube: &Kube,
    path: &str,
    label_selector: &Option<String>,
    field_selector: &Option<String>,
) -> Result<(Vec<Value>, String), ApiError> {
    let mut items = Vec::new();
    let mut continue_token: Option<String> = None;
    loop {
        let url = with_query(
            path,
            &[
                ("labelSelector", label_selector.clone()),
                ("fieldSelector", field_selector.clone()),
                ("limit", Some("500".into())),
                ("continue", continue_token.clone()),
            ],
        );
        let page = kube.get(&url).await?;
        let version = page
            .pointer("/metadata/resourceVersion")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();

        // A list's items omit `kind` and `apiVersion`; put them back so the
        // browser can treat listed and watched objects alike.
        let kind = page.get("kind").and_then(Value::as_str).unwrap_or_default().trim_end_matches("List").to_string();
        let api_version = page.get("apiVersion").cloned().unwrap_or(Value::Null);

        for mut item in page.get("items").and_then(Value::as_array).cloned().unwrap_or_default() {
            if let Some(object) = item.as_object_mut() {
                object.entry("kind").or_insert_with(|| Value::String(kind.clone()));
                object.entry("apiVersion").or_insert_with(|| api_version.clone());
            }
            items.push(slim(item));
        }

        continue_token = page
            .pointer("/metadata/continue")
            .and_then(Value::as_str)
            .filter(|c| !c.is_empty())
            .map(String::from);
        if continue_token.is_none() {
            return Ok((items, version));
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn watch(
    kube: &Kube,
    path: &str,
    params: &WatchParams,
    field_selector: &Option<String>,
    version: &mut String,
    emit: &(impl Fn(Value) -> bool + Send + Sync),
    failures: &mut u32,
) -> Result<Outcome, ApiError> {
    loop {
        let url = with_query(
            path,
            &[
                ("watch", Some("true".into())),
                ("allowWatchBookmarks", Some("true".into())),
                ("timeoutSeconds", Some("240".into())),
                ("resourceVersion", Some(version.clone())),
                ("labelSelector", params.label_selector.clone()),
                ("fieldSelector", field_selector.clone()),
            ],
        );

        let mut stream = match kube.lines(&url).await {
            Ok(stream) => Box::pin(stream),
            Err(e) if e.status == 410 => return Ok(Outcome::Relist),
            Err(e) if e.status == 403 || e.status == 404 => return Err(e),
            Err(_) => {
                *failures += 1;
                tokio::time::sleep(backoff(*failures)).await;
                return Ok(Outcome::Relist);
            }
        };

        while let Some(event) = stream.next().await {
            let event = match event {
                Ok(event) => event,
                // A broken stream resumes from the last version seen.
                Err(_) => break,
            };
            *failures = 0;

            let kind = event.get("type").and_then(Value::as_str).unwrap_or_default().to_string();
            let object = event.get("object").cloned().unwrap_or(Value::Null);

            match kind.as_str() {
                "BOOKMARK" => {
                    if let Some(rv) = object.pointer("/metadata/resourceVersion").and_then(Value::as_str) {
                        *version = rv.to_string();
                    }
                }
                "ERROR" => {
                    let code = object.get("code").and_then(Value::as_u64).unwrap_or(0);
                    if code == 410 {
                        return Ok(Outcome::Relist);
                    }
                    tokio::time::sleep(backoff(1)).await;
                    return Ok(Outcome::Relist);
                }
                _ => {
                    if let Some(rv) = object.pointer("/metadata/resourceVersion").and_then(Value::as_str) {
                        *version = rv.to_string();
                    }
                    if !emit(json!({ "type": kind, "object": slim(object) })) {
                        return Ok(Outcome::Stop);
                    }
                }
            }
        }
    }
}
