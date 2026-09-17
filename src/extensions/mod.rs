//! Backend extensions.
//!
//! Everything the gateway serves is registered by an [`Extension`] — the core
//! included — so adding a capability is a new module and one line in
//! [`builtin`]. An extension names the API resources it needs; the browser
//! reads that from the `hello` frame and hides screens the cluster cannot
//! back.

pub mod atomic_usb;
pub mod core;
pub mod datavolumes;
pub mod kubevirt;
pub mod metrics;
pub mod migration;
pub mod nodes;
pub mod proxmox;
pub mod storage;

use crate::rpc::{Extension, Registry};

/// The extensions compiled into this build.
pub fn builtin() -> Vec<Box<dyn Extension>> {
    vec![
        Box::new(core::Core),
        Box::new(kubevirt::KubeVirt),
        Box::new(nodes::Nodes),
        Box::new(storage::Storage),
        Box::new(metrics::Metrics),
        Box::new(atomic_usb::AtomicUsb),
        Box::new(proxmox::Proxmox),
    ]
}

/// A registry with every extension installed, except those switched off.
pub fn registry(disabled: &[String]) -> Registry {
    let mut registry = Registry::default();
    for extension in builtin() {
        let id = extension.manifest().id;
        if id != "core" && disabled.iter().any(|d| d == &id) {
            tracing::info!(extension = %id, "extension disabled by configuration");
            continue;
        }
        registry.install(extension.as_ref());
    }
    registry
}
