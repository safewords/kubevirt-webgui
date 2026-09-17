//! An extensible, Proxmox-inspired web GUI for KubeVirt — libvirt virtual
//! machines on Kubernetes.
//!
//! Every action travels over one WebSocket (`/ws`) and is made with the
//! signed-in user's own cluster credential, so Kubernetes RBAC decides what
//! each person may do. See [`gateway`] for the protocol and [`extensions`]
//! for how capabilities are added.

pub mod auth;
pub mod bootstrap;
pub mod cluster;
pub mod extensions;
pub mod gateway;
pub mod metrics;
pub mod rpc;
pub mod settings;
pub mod spa;
pub mod state;
pub mod tasks;
