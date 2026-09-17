//! Disk images: uploads from the browser into CDI DataVolumes.
//!
//! Downloads from a URL need no server code — a DataVolume with an `http`
//! source makes CDI fetch (and convert: qcow2, VMDK, VHD(X), compressed
//! images) inside the cluster, created with the generic `datavolume.create`.
//! An upload is different: the bytes are in the browser, so they travel over
//! a socket — see [`crate::gateway::upload`].

use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::cluster::paths::{ResourceRef, segment};
use crate::cluster::Kube;
use crate::gateway::upload::{UploadSession, UploadState, uploads};
use crate::rpc::{Ctx, Extension, ExtensionManifest, Registry, RpcError, RpcResult, params};
use crate::tasks::{TaskHandle, TaskTarget};

use super::datavolumes::{self, Settled};

pub struct Storage;

impl Extension for Storage {
    fn manifest(&self) -> ExtensionManifest {
        ExtensionManifest {
            id: "storage".into(),
            name: "Storage".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            description: "Disk image uploads over WebSocket into CDI DataVolumes (ISO, raw, qcow2, VMDK, VHD).".into(),
            requires: vec!["cdi.kubevirt.io/v1beta1/datavolumes".into()],
            methods: vec![],
            topics: vec![],
        }
    }

    fn register(&self, r: &mut Registry) {
        r.method("upload.begin", begin);
        r.method("datavolume.diagnose", diagnose);
    }
}

const GIB: u64 = 1024 * 1024 * 1024;

/// The claim size for an image of `bytes`: a tenth extra for filesystem
/// overhead, rounded up to a whole GiB.
pub fn claim_size(bytes: u64) -> u64 {
    let padded = bytes + bytes / 10;
    padded.div_ceil(GIB).max(1) * GIB
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BeginParams {
    namespace: String,
    name: String,
    /// The file's size in bytes.
    size: u64,
    /// The disk to create, when the image's virtual size is larger than the
    /// file (qcow2, VMDK): a Kubernetes quantity like `20Gi`.
    #[serde(default)]
    disk_size: Option<String>,
    #[serde(default)]
    storage_class: Option<String>,
    /// `iso` or `disk` — labels the result for the image library.
    #[serde(default)]
    image_type: Option<String>,
    #[serde(default)]
    file_name: Option<String>,
    #[serde(default)]
    labels: Option<serde_json::Map<String, Value>>,
}

fn str_at<'a>(value: &'a Value, pointer: &str) -> &'a str {
    value.pointer(pointer).and_then(Value::as_str).unwrap_or_default()
}


/// Why a DataVolume's CDI pod is failing, if it is: `{ trouble: { pod, node, restarts, message, hint } | null }`.
async fn diagnose(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    struct P {
        namespace: String,
        name: String,
    }
    let p: P = params(p)?;
    segment("namespace", &p.namespace)?;
    segment("name", &p.name)?;
    Ok(datavolumes::diagnose(&ctx.kube()?, &p.namespace, &p.name).await?)
}

/// Begin an upload: returns `{ task, ticket, path }`; the browser opens
/// `path` and follows the protocol in [`crate::gateway::upload`].
async fn begin(ctx: Ctx, p: Value) -> RpcResult {
    let p: BeginParams = params(p)?;
    segment("namespace", &p.namespace)?;
    segment("name", &p.name)?;
    if p.size == 0 {
        return Err(RpcError::bad_request("the file is empty"));
    }
    if let Some(class) = &p.storage_class {
        segment("storageClass", class)?;
    }
    let image_type = p.image_type.clone().unwrap_or_else(|| "disk".into());
    if image_type != "iso" && image_type != "disk" {
        return Err(RpcError::bad_request("imageType must be `iso` or `disk`"));
    }

    let session = ctx.session()?;
    let kube = session.kube.clone();
    let upload = UploadSession::new(&p.namespace, &p.name, p.size, &session.user.username, kube.clone());
    let ticket = uploads().issue(upload.clone());

    let mut labels = p.labels.clone().unwrap_or_default();
    labels.insert("kubevirt-webgui/image-type".into(), json!(image_type));
    let storage = p.disk_size.clone().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| format!("{}Gi", claim_size(p.size) / GIB));
    let mut spec = json!({
        "source": { "upload": {} },
        "contentType": "kubevirt",
        "storage": { "resources": { "requests": { "storage": storage } } }
    });
    if let Some(class) = &p.storage_class {
        spec["storage"]["storageClassName"] = json!(class);
    }
    let body = json!({
        "apiVersion": "cdi.kubevirt.io/v1beta1",
        "kind": "DataVolume",
        "metadata": {
            "name": p.name,
            "namespace": p.namespace,
            "labels": labels,
            "annotations": {
                "kubevirt-webgui/source": "upload",
                "kubevirt-webgui/file-name": p.file_name.clone().unwrap_or_default(),
                // Keep the claim when the upload completes, even if no VM uses it yet.
                "cdi.kubevirt.io/storage.bind.immediate.requested": "true",
            }
        },
        "spec": spec,
    });

    let target = TaskTarget { kind: "DataVolume".into(), namespace: Some(p.namespace.clone()), name: p.name.clone() };
    let description = format!("Upload {} to {}/{}", p.file_name.as_deref().unwrap_or("image"), p.namespace, p.name);
    let task_upload = upload.clone();
    let reply = ctx.task("disk.upload", target, description, move |task| async move {
        let result = run(&task, &kube, &task_upload, &body, &storage).await;
        if let Err(e) = &result {
            task_upload.fail(e.message.clone());
        }
        result
    })?;

    Ok(json!({ "task": reply["task"], "ticket": ticket, "path": format!("/ws/upload/{ticket}") }))
}

async fn run(task: &TaskHandle, kube: &Kube, upload: &UploadSession, body: &Value, storage: &str) -> RpcResult<Option<String>> {
    let ns = upload.namespace.as_str();
    let collection = ResourceRef::new("cdi.kubevirt.io/v1beta1", "datavolumes").ns(ns);
    kube.post(&collection.path()?, body).await?;
    task.log(format!("created DataVolume {ns}/{} ({storage}, {} bytes to upload)", upload.name, upload.size));

    // 1. CDI starts an upload server for the claim — unless the browser gives
    // up first, or the server pod keeps failing (which `follow` explains).
    let mut cancelled = upload.watch();
    let abandoned = async {
        loop {
            if let UploadState::Failed(reason) = cancelled.borrow_and_update().clone() {
                return reason;
            }
            if cancelled.changed().await.is_err() {
                return "the upload was abandoned".to_string();
            }
        }
    };
    let settled = tokio::select! {
        settled = datavolumes::follow(task, kube, ns, &upload.name, "DataVolume", &["UploadReady"], Duration::from_secs(15 * 60)) => settled?,
        reason = abandoned => return Err(RpcError::internal(reason)),
    };
    match settled {
        Settled::Reached(_) => {}
        Settled::Ready(phase) if phase == "Succeeded" => return Err(RpcError::new(409, "Conflict", "the DataVolume has already been filled")),
        Settled::Ready(phase) => return Err(RpcError::internal(format!("CDI did not start an upload server (DataVolume {phase})"))),
    }

    // 2. A token that lets exactly this claim be written.
    let request = json!({
        "apiVersion": "upload.cdi.kubevirt.io/v1beta1",
        "kind": "UploadTokenRequest",
        "metadata": { "name": upload.name, "namespace": ns },
        "spec": { "pvcName": upload.name }
    });
    let token_path = ResourceRef::new("upload.cdi.kubevirt.io/v1beta1", "uploadtokenrequests").ns(ns).path()?;
    let response = kube.post(&token_path, &request).await?;
    let token = str_at(&response, "/status/token").to_string();
    if token.is_empty() {
        return Err(RpcError::internal("CDI issued no upload token"));
    }
    upload.set(UploadState::Ready { token });
    task.log("upload server ready; receiving the file from the browser");

    // 3. The bytes, as the socket forwards them.
    let mut states = upload.watch();
    let mut logged_step = 0u64;
    let waiting_since = Instant::now();
    loop {
        let state = states.borrow_and_update().clone();
        match state {
            UploadState::Finished => break,
            UploadState::Failed(reason) => return Err(RpcError::internal(reason)),
            UploadState::Uploading { sent } => {
                let step = sent * 10 / upload.size.max(1);
                if step > logged_step {
                    logged_step = step;
                    task.log(format!("sent {}% ({} MiB)", step * 10, sent / (1024 * 1024)));
                }
            }
            UploadState::Ready { .. } | UploadState::Preparing => {
                if waiting_since.elapsed() > Duration::from_secs(10 * 60) {
                    return Err(RpcError::new(504, "Timeout", "the browser did not start sending within 10 minutes"));
                }
            }
        }
        if tokio::time::timeout(Duration::from_secs(30), states.changed()).await.is_ok_and(|r| r.is_err()) {
            return Err(RpcError::internal("the upload was abandoned"));
        }
    }
    task.log("all bytes received by CDI; processing the image");

    // 4. CDI validates and converts the image.
    datavolumes::follow(task, kube, ns, &upload.name, "DataVolume", &[], Duration::from_secs(4 * 3600)).await?;
    Ok(Some(format!("image stored in {ns}/{}", upload.name)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claims_leave_room_and_round_to_gibibytes() {
        assert_eq!(claim_size(1), GIB);
        assert_eq!(claim_size(GIB), 2 * GIB);
        assert_eq!(claim_size(900 * 1024 * 1024), GIB);
        assert_eq!(claim_size(5 * GIB), 6 * GIB);
    }
}
