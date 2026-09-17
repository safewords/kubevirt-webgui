//! atomic-usb — USB devices from any node, attached to VMs on any other.
//!
//! An example of an add-on extension: it registers two methods of its own and
//! leaves listing and watching to the generic `resource.*` and `watch`. The
//! browser plugin that pairs with it only appears when the cluster serves
//! `atomicusb.safewords.io`.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::cluster::paths::{ResourceRef, segment};
use crate::rpc::{Ctx, Extension, ExtensionManifest, Registry, RpcError, RpcResult, params};
use crate::tasks::TaskTarget;

pub struct AtomicUsb;

const API: &str = "atomicusb.safewords.io/v1alpha1";

impl Extension for AtomicUsb {
    fn manifest(&self) -> ExtensionManifest {
        ExtensionManifest {
            id: "atomic-usb".into(),
            name: "atomic-usb".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            description: "Attach USB devices plugged into any node to VMs running on any other node.".into(),
            requires: vec![format!("{API}/usbdevices"), format!("{API}/usbdeviceclaims")],
            methods: vec![],
            topics: vec![],
        }
    }

    fn register(&self, r: &mut Registry) {
        r.method("usb.attach", attach);
        r.method("usb.detach", detach);
    }
}

fn str_at<'a>(value: &'a Value, pointer: &str) -> &'a str {
    value.pointer(pointer).and_then(Value::as_str).unwrap_or_default()
}

async fn attach(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct P {
        namespace: String,
        vm: String,
        device: String,
        #[serde(default)]
        claim: Option<String>,
        /// Follow the device by identity (serial) rather than pinning this
        /// exact device name.
        #[serde(default = "yes")]
        follow: bool,
    }
    fn yes() -> bool {
        true
    }
    let p: P = params(p)?;
    segment("namespace", &p.namespace)?;
    segment("vm", &p.vm)?;
    segment("device", &p.device)?;
    let kube = ctx.kube()?;

    ctx.task(
        "usb.attach",
        TaskTarget { kind: "VirtualMachine".into(), namespace: Some(p.namespace.clone()), name: p.vm.clone() },
        format!("Attach USB {} to {}/{}", p.device, p.namespace, p.vm),
        move |task| async move {
            let device = kube.get(&ResourceRef::new(API, "usbdevices").named(&p.device).path()?).await?;
            if let Some(holder) = device.pointer("/status/attachedTo/claim").and_then(Value::as_str) {
                return Err(RpcError::new(409, "Conflict", format!("the device is already claimed by {holder}")));
            }

            let mut selector = json!({
                "vendorId": str_at(&device, "/spec/vendorId"),
                "productId": str_at(&device, "/spec/productId"),
            });
            let serial = str_at(&device, "/spec/serial");
            if p.follow && !serial.is_empty() && str_at(&device, "/spec/identity").starts_with("Serial") {
                selector["serial"] = json!(serial);
            } else {
                selector["deviceName"] = json!(p.device);
            }

            let claim = p.claim.clone().filter(|c| !c.is_empty()).unwrap_or_else(|| {
                format!("{}-{}", p.vm, p.device).chars().take(63).collect::<String>().trim_end_matches('-').to_string()
            });
            segment("claim", &claim)?;
            let body = json!({
                "apiVersion": API,
                "kind": "UsbDeviceClaim",
                "metadata": { "name": claim, "namespace": p.namespace },
                "spec": { "vmName": p.vm, "selector": selector }
            });
            let collection = ResourceRef::new(API, "usbdeviceclaims").ns(&p.namespace);
            kube.post(&collection.path()?, &body).await?;
            task.log(format!("created UsbDeviceClaim {claim}"));

            let path = collection.named(&claim).path()?;
            let mut last = String::new();
            for _ in 0..90 {
                let current = kube.get(&path).await?;
                let line = format!("{}: {}", str_at(&current, "/status/phase"), str_at(&current, "/status/message"));
                if line != last {
                    task.log(line.clone());
                    last = line;
                }
                if str_at(&current, "/status/phase") == "Attached" {
                    return Ok(Some("device attached".into()));
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            Ok(Some("claim created; the device will attach when it and the VM are available".into()))
        },
    )
}

async fn detach(ctx: Ctx, p: Value) -> RpcResult {
    #[derive(Deserialize)]
    struct P {
        namespace: String,
        claim: String,
    }
    let p: P = params(p)?;
    let kube = ctx.kube()?;
    ctx.task(
        "usb.detach",
        TaskTarget { kind: "UsbDeviceClaim".into(), namespace: Some(p.namespace.clone()), name: p.claim.clone() },
        format!("Detach USB claim {}/{}", p.namespace, p.claim),
        move |_task| async move {
            kube.delete(&ResourceRef::new(API, "usbdeviceclaims").ns(&p.namespace).named(&p.claim).path()?, None)
                .await?;
            Ok(Some("claim deleted; the device is released".into()))
        },
    )
}
