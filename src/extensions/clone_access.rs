//! Letting one namespace clone disks out of another.
//!
//! CDI refuses a cross-namespace clone unless the *target* namespace's
//! ServiceAccount may `create datavolumes/source` in the source namespace. A
//! VM's DataVolume templates are created by virt-controller on behalf of the
//! VM's namespace's `default` ServiceAccount, so a VM that boots from an ISO in
//! the image library fails with "insufficient permissions in clone source
//! namespace" long after the wizard said it was created — and every start
//! after that is refused with "stop/start already underway".
//!
//! Before such a VM or disk is created, this grants exactly that permission:
//! a Role in the source namespace that allows nothing but cloning, bound to
//! the target namespace's ServiceAccounts. It runs as the signed-in user, so
//! it only succeeds for someone who could have granted it by hand.

use std::collections::BTreeSet;

use serde_json::{Value, json};

use crate::cluster::Kube;
use crate::cluster::paths::ResourceRef;
use crate::tasks::TaskHandle;

/// The Role, in each source namespace, that allows cloning and nothing else.
pub const ROLE: &str = "kubevirt-webgui-clone-source";

fn str_at<'a>(value: &'a Value, pointer: &str) -> &'a str {
    value.pointer(pointer).and_then(Value::as_str).unwrap_or_default()
}

/// The namespaces, other than `target`, that these DataVolumes (or VM
/// `dataVolumeTemplates`) clone from.
pub fn sources<'a>(target: &str, data_volumes: impl IntoIterator<Item = &'a Value>) -> BTreeSet<String> {
    data_volumes
        .into_iter()
        .flat_map(|dv| {
            [
                str_at(dv, "/spec/source/pvc/namespace"),
                str_at(dv, "/spec/source/snapshot/namespace"),
                if str_at(dv, "/spec/sourceRef/kind") == "DataSource" {
                    str_at(dv, "/spec/sourceRef/namespace")
                } else {
                    ""
                },
            ]
        })
        .filter(|ns| !ns.is_empty() && *ns != target)
        .map(String::from)
        .collect()
}

/// The RoleBinding's name for clones into `target`.
pub fn binding_name(target: &str) -> String {
    format!("kubevirt-webgui-clone-to-{target}")
}

fn role(source: &str) -> Value {
    json!({
        "apiVersion": "rbac.authorization.k8s.io/v1",
        "kind": "Role",
        "metadata": {
            "name": ROLE,
            "namespace": source,
            "labels": { "app.kubernetes.io/managed-by": "kubevirt-webgui" },
        },
        "rules": [{ "apiGroups": ["cdi.kubevirt.io"], "resources": ["datavolumes/source"], "verbs": ["create"] }],
    })
}

fn binding(source: &str, target: &str) -> Value {
    json!({
        "apiVersion": "rbac.authorization.k8s.io/v1",
        "kind": "RoleBinding",
        "metadata": {
            "name": binding_name(target),
            "namespace": source,
            "labels": { "app.kubernetes.io/managed-by": "kubevirt-webgui" },
        },
        "roleRef": { "apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": ROLE },
        // CDI's access review names the ServiceAccount without its groups, so
        // the group alone is not enough; it covers a VM that sets its own.
        "subjects": [
            { "kind": "ServiceAccount", "name": "default", "namespace": target },
            { "apiGroup": "rbac.authorization.k8s.io", "kind": "Group", "name": format!("system:serviceaccounts:{target}") },
        ],
    })
}

/// Create `object` unless it already exists.
async fn create_once(kube: &Kube, collection: ResourceRef, object: &Value) -> Result<bool, String> {
    match kube.post(&collection.path().map_err(|e| e.message)?, object).await {
        Ok(_) => Ok(true),
        Err(e) if e.status == 409 => Ok(false),
        Err(e) => Err(e.message),
    }
}

/// Let `target`'s ServiceAccounts clone out of each of `sources`. A refusal is
/// logged with what an administrator would need to do, not raised: the user
/// may lack RBAC rights the cluster has already granted some other way.
pub async fn grant(task: &TaskHandle, kube: &Kube, target: &str, sources: &BTreeSet<String>) {
    for source in sources {
        let roles = ResourceRef::new("rbac.authorization.k8s.io/v1", "roles").ns(source);
        let bindings = ResourceRef::new("rbac.authorization.k8s.io/v1", "rolebindings").ns(source);
        let outcome = async {
            create_once(kube, roles, &role(source)).await?;
            create_once(kube, bindings, &binding(source, target)).await
        }
        .await;
        match outcome {
            Ok(true) => task.log(format!("allowed {target} to clone disks from {source}")),
            Ok(false) => {}
            Err(message) => task.log(format!(
                "could not allow {target} to clone disks from {source} ({message}); unless something else grants \
                 `create datavolumes/source` in {source} to system:serviceaccount:{target}:default, CDI will refuse the clone"
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_cross_namespace_sources_only() {
        let dvs = [
            json!({ "spec": { "source": { "pvc": { "namespace": "kubevirt-images", "name": "win11" } } } }),
            json!({ "spec": { "source": { "pvc": { "namespace": "vms", "name": "local" } } } }),
            json!({ "spec": { "source": { "blank": {} } } }),
            json!({ "spec": { "sourceRef": { "kind": "DataSource", "namespace": "golden", "name": "fedora" } } }),
            json!({ "spec": { "source": { "snapshot": { "namespace": "snaps", "name": "s" } } } }),
        ];
        let found: Vec<String> = sources("vms", &dvs).into_iter().collect();
        assert_eq!(found, ["golden", "kubevirt-images", "snaps"]);
    }

    #[test]
    fn binding_names_the_serviceaccount_and_its_group() {
        let b = binding("kubevirt-images", "team-a");
        assert_eq!(b["metadata"]["name"], "kubevirt-webgui-clone-to-team-a");
        assert_eq!(b["subjects"][0]["namespace"], "team-a");
        assert_eq!(b["subjects"][1]["name"], "system:serviceaccounts:team-a");
    }
}
