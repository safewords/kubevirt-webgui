//! What the cluster can do — which API groups and resources exist.
//!
//! The browser uses this to decide which screens to offer: a snapshot tab
//! without `snapshot.kubevirt.io`, or a USB panel without atomic-usb, would be
//! a screen that can only fail. Discovery is the same for every user, so it is
//! computed once and cached.

use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::future::join_all;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::RwLock;

use super::{ApiError, Kube};

/// One resource a group/version serves.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResource {
    pub name: String,
    pub kind: String,
    pub namespaced: bool,
    pub verbs: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub short_names: Vec<String>,
}

/// A group, and the versions it serves.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiGroup {
    pub name: String,
    pub preferred_version: String,
    pub versions: Vec<String>,
}

/// The whole picture.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub server_version: Value,
    pub kubevirt_version: Option<Value>,
    pub groups: Vec<ApiGroup>,
    /// Keyed by `group/version` (or `v1` for the core group).
    pub resources: std::collections::BTreeMap<String, Vec<ApiResource>>,
}

impl Discovery {
    /// Whether `group/version` serves `resource`.
    pub fn has(&self, api_version: &str, resource: &str) -> bool {
        self.resources
            .get(api_version)
            .is_some_and(|resources| resources.iter().any(|r| r.name == resource))
    }

    /// Whether a `group/version/resource` (or `version/resource` for the core
    /// group) requirement is served.
    pub fn serves(&self, requirement: &str) -> bool {
        match requirement.rsplit_once('/') {
            Some((api_version, resource)) if api_version.contains('/') || api_version == "v1" => self.has(api_version, resource),
            // A bare group, or `group/version`.
            _ => self.has_group(requirement.split('/').next().unwrap_or(requirement)),
        }
    }

    /// Whether any version of `group` is served.
    pub fn has_group(&self, group: &str) -> bool {
        self.groups.iter().any(|g| g.name == group)
    }
}

#[derive(Default)]
pub struct DiscoveryCache {
    cached: RwLock<Option<(Instant, Arc<Discovery>)>>,
}

const FRESH_FOR: Duration = Duration::from_secs(60);

impl DiscoveryCache {
    /// Discovery, from the cache when it is fresh.
    pub async fn get(&self, kube: &Kube, refresh: bool) -> Result<Arc<Discovery>, ApiError> {
        if !refresh {
            if let Some((at, discovery)) = self.cached.read().await.as_ref() {
                if at.elapsed() < FRESH_FOR {
                    return Ok(discovery.clone());
                }
            }
        }

        let discovery = Arc::new(discover(kube).await?);
        *self.cached.write().await = Some((Instant::now(), discovery.clone()));
        Ok(discovery)
    }

    /// Discovery again, unless it was fetched within `min_age` — for a caller
    /// that found something missing and wants to rule out a stale cache
    /// without letting a client force a rescan on every request.
    pub async fn refresh_unless_recent(&self, kube: &Kube, min_age: Duration) -> Result<Arc<Discovery>, ApiError> {
        if let Some((at, discovery)) = self.cached.read().await.as_ref() {
            if at.elapsed() < min_age {
                return Ok(discovery.clone());
            }
        }
        self.get(kube, true).await
    }
}

fn parse_resources(list: &Value) -> Vec<ApiResource> {
    list.get("resources")
        .and_then(Value::as_array)
        .map(|resources| {
            resources
                .iter()
                .filter_map(|r| {
                    Some(ApiResource {
                        name: r.get("name")?.as_str()?.to_string(),
                        kind: r.get("kind")?.as_str()?.to_string(),
                        namespaced: r.get("namespaced").and_then(Value::as_bool).unwrap_or(false),
                        verbs: r
                            .get("verbs")
                            .and_then(Value::as_array)
                            .map(|v| v.iter().filter_map(Value::as_str).map(String::from).collect())
                            .unwrap_or_default(),
                        short_names: r
                            .get("shortNames")
                            .and_then(Value::as_array)
                            .map(|v| v.iter().filter_map(Value::as_str).map(String::from).collect())
                            .unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn discover(kube: &Kube) -> Result<Discovery, ApiError> {
    let server_version = kube.get("/version").await?;
    let groups_list = kube.get("/apis").await?;

    let mut groups = Vec::new();
    for group in groups_list.get("groups").and_then(Value::as_array).into_iter().flatten() {
        let Some(name) = group.get("name").and_then(Value::as_str) else { continue };
        let versions: Vec<String> = group
            .get("versions")
            .and_then(Value::as_array)
            .map(|v| {
                v.iter()
                    .filter_map(|v| v.get("version").and_then(Value::as_str))
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default();
        let preferred = group
            .pointer("/preferredVersion/version")
            .and_then(Value::as_str)
            .map(String::from)
            .or_else(|| versions.first().cloned())
            .unwrap_or_default();
        groups.push(ApiGroup { name: name.to_string(), preferred_version: preferred, versions });
    }

    // Every served version, fetched concurrently: a GUI wants to know that
    // `snapshot.kubevirt.io/v1beta1` exists even when `v1alpha1` is preferred.
    let mut targets = vec![("v1".to_string(), "/api/v1".to_string())];
    for group in &groups {
        for version in &group.versions {
            targets.push((format!("{}/{}", group.name, version), format!("/apis/{}/{}", group.name, version)));
        }
    }

    let fetched = join_all(targets.into_iter().map(|(key, path)| async move {
        // An aggregated API whose backend is down answers 503; that group is
        // simply absent rather than failing the whole picture.
        let list = kube.get(&path).await.ok()?;
        Some((key, parse_resources(&list)))
    }))
    .await;

    let resources = fetched.into_iter().flatten().collect();

    let kubevirt_version = kube.get("/apis/subresources.kubevirt.io/v1/version").await.ok();

    Ok(Discovery { server_version, kubevirt_version, groups, resources })
}
