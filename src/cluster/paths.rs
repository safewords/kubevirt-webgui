//! Addressing Kubernetes resources safely.
//!
//! Every path the gateway builds comes from values a browser sent, so each
//! segment is validated rather than trusted: a name containing `/` or `?`
//! would otherwise let a client reach an endpoint it never named.

use serde::{Deserialize, Serialize};

use super::ApiError;

/// Whether `segment` is safe to place in an API path.
pub fn valid_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment.len() <= 253
        && segment != "."
        && segment != ".."
        && segment.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | ':' | '@' | '+'))
}

/// Reject an unsafe path segment with a client error.
pub fn segment<'a>(what: &str, value: &'a str) -> Result<&'a str, ApiError> {
    if valid_segment(value) {
        Ok(value)
    } else {
        Err(ApiError::bad_request(format!("`{what}` is not a valid name: {value:?}")))
    }
}

/// A resource — or a collection of them — by group, version and plural.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResourceRef {
    /// `v1` for the core group, otherwise `group/version`.
    pub api_version: String,
    /// The plural resource name, e.g. `virtualmachines`.
    pub resource: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subresource: Option<String>,
}

impl ResourceRef {
    /// A reference into a group/version.
    pub fn new(api_version: &str, resource: &str) -> Self {
        Self { api_version: api_version.into(), resource: resource.into(), ..Default::default() }
    }

    /// In this namespace.
    pub fn ns(mut self, namespace: impl Into<String>) -> Self {
        self.namespace = Some(namespace.into());
        self
    }

    /// This object.
    pub fn named(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    /// This subresource of the object.
    pub fn subresource(mut self, subresource: impl Into<String>) -> Self {
        self.subresource = Some(subresource.into());
        self
    }

    /// The API path, validated.
    pub fn path(&self) -> Result<String, ApiError> {
        let mut path = api_base(&self.api_version)?;

        if let Some(namespace) = self.namespace.as_deref().filter(|ns| !ns.is_empty()) {
            path.push_str("/namespaces/");
            path.push_str(segment("namespace", namespace)?);
        }
        path.push('/');
        path.push_str(segment("resource", &self.resource)?);

        if let Some(name) = self.name.as_deref() {
            path.push('/');
            path.push_str(segment("name", name)?);
        }
        if let Some(subresource) = self.subresource.as_deref() {
            if self.name.is_none() {
                return Err(ApiError::bad_request("a subresource needs an object name"));
            }
            for part in subresource.split('/') {
                path.push('/');
                path.push_str(segment("subresource", part)?);
            }
        }
        Ok(path)
    }
}

/// `/api/v1` or `/apis/group/version`.
pub fn api_base(api_version: &str) -> Result<String, ApiError> {
    match api_version.split_once('/') {
        None => Ok(format!("/api/{}", segment("apiVersion", api_version)?)),
        Some((group, version)) => {
            Ok(format!("/apis/{}/{}", segment("apiVersion", group)?, segment("apiVersion", version)?))
        }
    }
}

/// Append query parameters, encoded.
pub fn with_query(path: &str, params: &[(&str, Option<String>)]) -> String {
    let query: Vec<String> = params
        .iter()
        .filter_map(|(key, value)| value.as_ref().map(|value| format!("{key}={}", urlencoding::encode(value))))
        .collect();

    if query.is_empty() { path.to_string() } else { format!("{path}?{}", query.join("&")) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_core_and_group_paths() {
        let pods = ResourceRef::new("v1", "pods").ns("default").named("web");
        assert_eq!(pods.path().unwrap(), "/api/v1/namespaces/default/pods/web");

        let start = ResourceRef::new("subresources.kubevirt.io/v1", "virtualmachines")
            .ns("vms")
            .named("db")
            .subresource("start");
        assert_eq!(start.path().unwrap(), "/apis/subresources.kubevirt.io/v1/namespaces/vms/virtualmachines/db/start");
    }

    #[test]
    fn rejects_path_injection() {
        assert!(ResourceRef::new("v1", "pods").named("../secrets").path().is_err());
        assert!(ResourceRef::new("v1", "pods").named("a?watch=1").path().is_err());
        assert!(ResourceRef::new("v1", "pods").ns("a/b").path().is_err());
        assert!(ResourceRef::new("v1/../..", "pods").path().is_err());
    }

    #[test]
    fn allows_rbac_style_names() {
        assert!(valid_segment("kubevirt.io:admin"));
        assert!(valid_segment("system:serviceaccount"));
    }
}
