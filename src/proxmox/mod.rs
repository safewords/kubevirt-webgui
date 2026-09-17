//! Importing virtual machines from Proxmox VE.
//!
//! The server signs in to a Proxmox host over SSH with credentials the person
//! types into the import wizard — held in memory for the wizard and the
//! import, never stored — reads the VM's configuration with `pvesh`, and
//! streams each disk out with `pvesm export` straight into a CDI upload. The
//! source VM is only read: it must be stopped, and nothing on the Proxmox side
//! is changed.
//!
//! Because the server makes these connections, it only makes them to hosts an
//! administrator has allowed (`PROXMOX_ALLOWED_HOSTS`).

pub mod config;
pub mod ssh;

use std::net::{IpAddr, SocketAddr};

/// Hosts the importer may connect to: `*`, host names, addresses and CIDR ranges.
#[derive(Debug, Clone, Default)]
pub struct AllowList {
    entries: Vec<Entry>,
}

#[derive(Debug, Clone, PartialEq)]
enum Entry {
    Any,
    Network(IpAddr, u8),
    Host(String),
}

fn in_network(ip: IpAddr, network: IpAddr, prefix: u8) -> bool {
    match (ip, network) {
        (IpAddr::V4(ip), IpAddr::V4(net)) => {
            let prefix = prefix.min(32);
            let mask = if prefix == 0 { 0 } else { u32::MAX << (32 - prefix) };
            u32::from(ip) & mask == u32::from(net) & mask
        }
        (IpAddr::V6(ip), IpAddr::V6(net)) => {
            let prefix = prefix.min(128);
            let mask = if prefix == 0 { 0 } else { u128::MAX << (128 - prefix) };
            u128::from(ip) & mask == u128::from(net) & mask
        }
        (IpAddr::V6(ip), IpAddr::V4(_)) => {
            ip.to_ipv4_mapped().is_some_and(|v4| in_network(IpAddr::V4(v4), network, prefix))
        }
        _ => false,
    }
}

impl AllowList {
    pub fn parse(items: &[String]) -> Self {
        let entries = items
            .iter()
            .filter_map(|item| {
                let item = item.trim();
                if item.is_empty() {
                    return None;
                }
                if item == "*" {
                    return Some(Entry::Any);
                }
                if let Some((addr, prefix)) = item.split_once('/') {
                    let addr: IpAddr = addr.parse().ok()?;
                    return Some(Entry::Network(addr, prefix.parse().ok()?));
                }
                if let Ok(addr) = item.parse::<IpAddr>() {
                    return Some(Entry::Network(addr, if addr.is_ipv4() { 32 } else { 128 }));
                }
                Some(Entry::Host(item.to_ascii_lowercase()))
            })
            .collect();
        Self { entries }
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn allows(&self, host: &str, ip: IpAddr) -> bool {
        self.entries.iter().any(|entry| match entry {
            Entry::Any => true,
            Entry::Network(network, prefix) => in_network(ip, *network, *prefix),
            Entry::Host(name) => name == &host.to_ascii_lowercase(),
        })
    }

    /// Resolve `host` and return an address the list allows. The connection
    /// goes to that exact address, so a DNS answer cannot change between the
    /// check and the connect.
    pub async fn resolve(&self, host: &str, port: u16) -> Result<SocketAddr, String> {
        if self.is_empty() {
            return Err("importing from Proxmox is not enabled on this server: an administrator sets PROXMOX_ALLOWED_HOSTS to the Proxmox hosts (names, addresses or CIDR ranges) it may connect to".into());
        }
        let host = host.trim().trim_start_matches('[').trim_end_matches(']');
        if host.is_empty()
            || host.len() > 253
            || host.chars().any(|c| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '_')))
        {
            return Err(format!("`{host}` is not a host name or address"));
        }
        let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
            .await
            .map_err(|e| format!("could not resolve {host}: {e}"))?
            .collect();
        addresses
            .iter()
            .find(|addr| self.allows(host, addr.ip()))
            .copied()
            .ok_or_else(|| format!("{host} is not among the hosts this server may import from (PROXMOX_ALLOWED_HOSTS)"))
    }
}

/// A Proxmox node name, VM id or storage id as it may appear in a command.
pub fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !value.starts_with(['-', '.'])
}

/// A volume id: `storage:volume`, with the characters Proxmox uses in volume names.
pub fn valid_volid(value: &str) -> bool {
    let Some((storage, volume)) = value.split_once(':') else {
        return false;
    };
    valid_name(storage)
        && !volume.is_empty()
        && volume.len() <= 256
        && !volume.contains("..")
        && volume.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | '+' | '='))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allow_lists() {
        let list =
            AllowList::parse(&["10.0.4.0/24".into(), "pve.example.com".into(), "192.168.1.10".into(), "".into()]);
        assert!(list.allows("10.0.4.2", "10.0.4.2".parse().unwrap()));
        assert!(!list.allows("10.0.5.2", "10.0.5.2".parse().unwrap()));
        assert!(list.allows("PVE.example.com", "203.0.113.9".parse().unwrap()));
        assert!(list.allows("192.168.1.10", "192.168.1.10".parse().unwrap()));
        assert!(!list.allows("192.168.1.11", "192.168.1.11".parse().unwrap()));
        assert!(list.allows("::ffff:10.0.4.9", "::ffff:10.0.4.9".parse().unwrap()));
        assert!(AllowList::parse(&["*".into()]).allows("anything", "8.8.8.8".parse().unwrap()));
        assert!(AllowList::parse(&[]).is_empty());
    }

    #[tokio::test]
    async fn an_empty_list_refuses_with_directions() {
        let error = AllowList::default().resolve("10.0.4.2", 22).await.unwrap_err();
        assert!(error.contains("PROXMOX_ALLOWED_HOSTS"));
        let list = AllowList::parse(&["10.0.4.0/24".into()]);
        assert!(list.resolve("10.0.4.2", 22).await.is_ok());
        assert!(list.resolve("127.0.0.1", 22).await.unwrap_err().contains("not among"));
        assert!(list.resolve("a b", 22).await.is_err());
    }

    #[test]
    fn names_and_volumes() {
        assert!(valid_name("pve-thin-2") && valid_name("107") && valid_name("ceph-ssd"));
        assert!(!valid_name("a;b") && !valid_name("-x") && !valid_name(""));
        assert!(valid_volid("ceph-ssd:vm-107-disk-1"));
        assert!(valid_volid("local:iso/debian-12.iso"));
        assert!(valid_volid("local:107/vm-107-disk-0.qcow2"));
        assert!(!valid_volid("ceph-ssd:vm-107-disk-1; reboot"));
        assert!(!valid_volid("local:../../etc/shadow"));
        assert!(!valid_volid("no-colon"));
    }
}
