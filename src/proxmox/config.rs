//! A Proxmox VM's configuration, read into the parts an import needs.
//!
//! `pvesh get /nodes/{node}/qemu/{vmid}/config` answers flat keys whose values
//! are Proxmox "property strings": `ceph-ssd:vm-107-disk-1,discard=on,size=64G`,
//! `virtio=02:1E:37:52:EA:4F,bridge=vmbr0`. This turns them into disks, NICs
//! and settings, and says plainly what an import will leave behind.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{Map, Value};

/// A property string: the leading bare value (if any) and its `key=value` pairs.
#[derive(Debug, Default, PartialEq)]
pub struct Props {
    pub head: Option<String>,
    pub pairs: BTreeMap<String, String>,
}

impl Props {
    pub fn parse(value: &str) -> Self {
        let mut props = Props::default();
        for (i, part) in value.split(',').enumerate() {
            let part = part.trim();
            if part.is_empty() {
                continue;
            }
            match part.split_once('=') {
                Some((k, v)) => {
                    props.pairs.insert(k.trim().to_string(), v.trim().to_string());
                }
                None if i == 0 => props.head = Some(part.to_string()),
                None => {
                    props.pairs.insert(part.to_string(), String::new());
                }
            }
        }
        props
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.pairs.get(key).map(String::as_str)
    }

    pub fn flag(&self, key: &str) -> bool {
        matches!(self.get(key), Some("1" | "on" | "yes" | "true"))
    }
}

/// `64G`, `528K`, `4M`, `1T` or plain bytes.
pub fn parse_size(value: &str) -> Option<u64> {
    let value = value.trim();
    let (number, unit) = match value.char_indices().find(|(_, c)| c.is_ascii_alphabetic()) {
        Some((i, _)) => (&value[..i], &value[i..]),
        None => (value, ""),
    };
    let number: f64 = number.parse().ok()?;
    let factor: u64 = match unit.to_ascii_uppercase().as_str() {
        "" | "B" => 1,
        "K" | "KB" | "KIB" => 1 << 10,
        "M" | "MB" | "MIB" => 1 << 20,
        "G" | "GB" | "GIB" => 1 << 30,
        "T" | "TB" | "TIB" => 1 << 40,
        _ => return None,
    };
    Some((number * factor as f64).round() as u64)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    /// `scsi0`, `virtio1`, `sata2`, `ide0`.
    pub key: String,
    pub bus: String,
    pub media: String,
    /// `storage:volume`, when on a Proxmox storage.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage: Option<String>,
    /// Exact size from the storage when known, else the config's rounded one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache: Option<String>,
    pub discard: bool,
    pub ssd: bool,
    pub iothread: bool,
    pub readonly: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial: Option<String>,
    /// Whether its data can be copied.
    pub importable: bool,
    /// Why not, or what to know.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Nic {
    pub key: String,
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mac: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bridge: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vlan: Option<u32>,
    pub firewall: bool,
    pub link_down: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queues: Option<u32>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsbPassthrough {
    pub key: String,
    /// `vendor:product` or a host port like `1-2`.
    pub host: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Smbios {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manufacturer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub product: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
}

/// Everything the import wizard shows and maps.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VmConfig {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ostype: Option<String>,
    /// `seabios` or `ovmf`.
    pub bios: String,
    /// `q35` or `i440fx`.
    pub machine: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine_version: Option<String>,
    pub sockets: u32,
    pub cores: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vcpus: Option<u32>,
    /// `host`, `kvm64`, `x86-64-v2-AES`, …
    pub cpu_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_flags: Option<String>,
    pub memory_mib: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balloon_mib: Option<u64>,
    pub onboot: bool,
    pub agent: bool,
    pub boot_order: Vec<String>,
    pub smbios: Smbios,
    pub efi_disk: bool,
    pub secure_boot: bool,
    pub tpm: bool,
    pub disks: Vec<Disk>,
    pub nics: Vec<Nic>,
    pub usb: Vec<UsbPassthrough>,
    pub serial_console: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vga: Option<String>,
    pub tablet: bool,
    pub localtime: bool,
    pub template: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lock: Option<String>,
    pub has_snapshots: bool,
    pub cloud_init: bool,
    /// Settings with no KubeVirt equivalent, in words.
    pub not_imported: Vec<String>,
    pub digest: String,
}

fn text(config: &Map<String, Value>, key: &str) -> Option<String> {
    match config.get(key)? {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(if *b { "1".into() } else { "0".into() }),
        _ => None,
    }
    .filter(|s| !s.is_empty())
}

fn number(config: &Map<String, Value>, key: &str) -> Option<u64> {
    text(config, key)?.parse().ok()
}

fn is_disk_key(key: &str) -> Option<(&'static str, u32)> {
    for bus in ["scsi", "virtio", "sata", "ide"] {
        if let Some(index) = key.strip_prefix(bus).and_then(|i| i.parse::<u32>().ok()) {
            return Some((bus, index));
        }
    }
    None
}

const NIC_MODELS: [&str; 11] = ["virtio", "e1000", "e1000e", "rtl8139", "vmxnet3", "i82551", "i82557b", "i82559er", "ne2k_isa", "ne2k_pci", "pcnet"];

/// Proxmox's Windows OS types: `win11`, `win10`, `w2k8`, `wxp`, …
pub fn is_windows(ostype: &str) -> bool {
    ostype.starts_with("win") || ostype.starts_with("w2k") || ostype == "wxp" || ostype == "wvista"
}

fn smbios_value(props: &Props, key: &str) -> Option<String> {
    let value = props.get(key)?.to_string();
    if props.flag("base64") {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.decode(&value).ok().and_then(|v| String::from_utf8(v).ok())
    } else {
        Some(value)
    }
}

/// Read a VM's configuration. `sizes` maps volume ids to exact sizes in bytes.
pub fn parse(config: &Map<String, Value>, sizes: &BTreeMap<String, u64>) -> VmConfig {
    let mut not_imported = Vec::new();

    let machine_raw = text(config, "machine").unwrap_or_default();
    let machine_type = Props::parse(&machine_raw).head.unwrap_or_default();
    let machine = if machine_type.contains("q35") { "q35" } else { "i440fx" }.to_string();
    let machine_version = machine_type.strip_prefix("pc-q35-").or_else(|| machine_type.strip_prefix("pc-i440fx-")).map(String::from);

    let cpu = Props::parse(&text(config, "cpu").unwrap_or_else(|| "kvm64".into()));
    let cpu_type = cpu.get("cputype").map(String::from).or(cpu.head.clone()).unwrap_or_else(|| "kvm64".into());

    let efidisk = text(config, "efidisk0").map(|v| Props::parse(&v));
    let smbios = text(config, "smbios1").map(|v| Props::parse(&v)).unwrap_or_default();

    let mut disks = Vec::new();
    let mut nics = Vec::new();
    let mut usb = Vec::new();
    let mut cloud_init = false;
    let mut serial_console = false;

    let mut keys: Vec<&String> = config.keys().collect();
    keys.sort_by_key(|k| {
        let digits = k.trim_start_matches(|c: char| c.is_ascii_alphabetic());
        (k.trim_end_matches(|c: char| c.is_ascii_digit()).to_string(), digits.parse::<u32>().unwrap_or(0))
    });

    for key in keys {
        let Some(value) = text(config, key) else { continue };
        if let Some((bus, _)) = is_disk_key(key) {
            let props = Props::parse(&value);
            let head = props.head.clone().unwrap_or_default();
            let media = props.get("media").unwrap_or("disk").to_string();
            let mut disk = Disk {
                key: key.clone(),
                bus: bus.into(),
                media: media.clone(),
                volid: None,
                storage: None,
                size_bytes: props.get("size").and_then(parse_size),
                format: props.get("format").map(String::from),
                cache: props.get("cache").map(String::from),
                discard: props.get("discard") == Some("on"),
                ssd: props.flag("ssd"),
                iothread: props.flag("iothread"),
                readonly: props.flag("ro"),
                serial: props.get("serial").map(String::from),
                importable: false,
                note: None,
            };
            if head.contains("cloudinit") {
                cloud_init = true;
                continue;
            }
            if head == "none" || head.is_empty() {
                if media == "cdrom" {
                    disk.note = Some("empty CD-ROM drive".into());
                    disks.push(disk);
                }
                continue;
            }
            if head.starts_with('/') {
                disk.note = Some(format!("passes through the host device {head}, which cannot be copied"));
                disks.push(disk);
                continue;
            }
            if let Some((storage, _)) = head.split_once(':') {
                disk.storage = Some(storage.to_string());
                disk.volid = Some(head.clone());
                if let Some(size) = sizes.get(&head) {
                    disk.size_bytes = Some(*size);
                }
                disk.importable = true;
                if media == "cdrom" {
                    disk.note = Some("ISO image".into());
                }
            }
            disks.push(disk);
        } else if let Some(index) = key.strip_prefix("net").and_then(|i| i.parse::<u32>().ok()) {
            let props = Props::parse(&value);
            let (model, mac) = match NIC_MODELS.iter().find(|m| props.pairs.contains_key(**m)) {
                Some(model) => (model.to_string(), props.get(model).filter(|m| !m.is_empty()).map(String::from)),
                None => (props.get("model").unwrap_or("virtio").to_string(), props.get("macaddr").map(String::from)),
            };
            let _ = index;
            nics.push(Nic {
                key: key.clone(),
                model,
                mac,
                bridge: props.get("bridge").map(String::from),
                vlan: props.get("tag").and_then(|t| t.parse().ok()),
                firewall: props.flag("firewall"),
                link_down: props.flag("link_down"),
                queues: props.get("queues").and_then(|q| q.parse().ok()),
            });
            if props.get("rate").is_some() {
                not_imported.push(format!("{key}: the {} MB/s rate limit", props.get("rate").unwrap_or_default()));
            }
        } else if key.starts_with("usb") && key[3..].parse::<u32>().is_ok() {
            let props = Props::parse(&value);
            match props.get("host") {
                Some(host) => usb.push(UsbPassthrough { key: key.clone(), host: host.to_string() }),
                None => not_imported.push(format!("{key}: {value}")),
            }
        } else if key.starts_with("serial") && key[6..].parse::<u32>().is_ok() {
            if value == "socket" {
                serial_console = true;
            } else {
                not_imported.push(format!("{key}: host serial port {value}"));
            }
        } else if key.starts_with("hostpci") {
            not_imported.push(format!("{key}: PCI passthrough ({value}) — attach devices through KubeVirt host devices"));
        } else if key.starts_with("unused") {
            not_imported.push(format!("{key}: detached disk {value}"));
        } else if key.starts_with("parallel") || key.starts_with("virtiofs") || key == "audio0" || key == "rng0" || key == "watchdog" || key == "args" || key == "hookscript" || key == "numa0" {
            not_imported.push(format!("{key}: {value}"));
        }
    }

    // Boot order: `order=scsi0;net0`, or the legacy `boot: cdn` + `bootdisk`.
    let boot = Props::parse(&text(config, "boot").unwrap_or_default());
    let boot_order: Vec<String> = match boot.get("order") {
        Some(order) => order.split(';').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect(),
        None => text(config, "bootdisk").into_iter().collect(),
    };

    if efidisk.is_some() {
        not_imported.push("efidisk0: the EFI variable store (boot entries) — the guest boots from its default loader path".into());
    }
    if text(config, "tpmstate0").is_some() {
        not_imported.push("tpmstate0: the TPM's contents (e.g. BitLocker keys) — the VM gets a fresh TPM".into());
    }
    if cloud_init {
        not_imported.push("cloud-init drive — its settings are not copied".into());
    }
    if let Some(balloon) = number(config, "balloon").filter(|b| *b > 0) {
        if Some(balloon) != number(config, "memory") {
            not_imported.push(format!("balloon: minimum memory {balloon} MiB"));
        }
    }
    for (key, what) in [("cpulimit", "CPU limit"), ("cpuunits", "CPU weight"), ("hugepages", "huge pages"), ("hotplug", "hotplug settings"), ("startup", "start-up order")] {
        if let Some(value) = text(config, key) {
            not_imported.push(format!("{key}: {what} ({value})"));
        }
    }

    let vga = text(config, "vga").map(|v| Props::parse(&v).head.unwrap_or(v));

    VmConfig {
        name: text(config, "name").unwrap_or_default(),
        description: text(config, "description"),
        tags: text(config, "tags").map(|t| t.split([';', ',', ' ']).filter(|s| !s.is_empty()).map(String::from).collect()).unwrap_or_default(),
        ostype: text(config, "ostype"),
        bios: text(config, "bios").unwrap_or_else(|| "seabios".into()),
        machine,
        machine_version,
        sockets: number(config, "sockets").unwrap_or(1).max(1) as u32,
        cores: number(config, "cores").unwrap_or(1).max(1) as u32,
        vcpus: number(config, "vcpus").map(|v| v as u32),
        cpu_type,
        cpu_flags: cpu.get("flags").map(String::from),
        memory_mib: number(config, "memory").unwrap_or(512),
        balloon_mib: number(config, "balloon"),
        onboot: text(config, "onboot").as_deref() == Some("1"),
        agent: text(config, "agent").is_some_and(|a| {
            let props = Props::parse(&a);
            props.head.as_deref() == Some("1") || props.flag("enabled")
        }),
        boot_order,
        smbios: Smbios {
            uuid: smbios_value(&smbios, "uuid"),
            serial: smbios_value(&smbios, "serial"),
            manufacturer: smbios_value(&smbios, "manufacturer"),
            product: smbios_value(&smbios, "product"),
            family: smbios_value(&smbios, "family"),
        },
        efi_disk: efidisk.is_some(),
        secure_boot: efidisk.as_ref().is_some_and(|e| e.flag("pre-enrolled-keys")),
        tpm: text(config, "tpmstate0").is_some(),
        disks,
        nics,
        usb,
        serial_console,
        vga,
        tablet: text(config, "tablet").as_deref() != Some("0"),
        // Proxmox keeps a Windows guest's clock in local time unless told otherwise.
        localtime: match text(config, "localtime").as_deref() {
            Some(value) => value == "1",
            None => text(config, "ostype").is_some_and(|os| is_windows(&os)),
        },
        template: text(config, "template").as_deref() == Some("1"),
        lock: text(config, "lock"),
        has_snapshots: text(config, "parent").is_some(),
        cloud_init,
        not_imported,
        digest: text(config, "digest").unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn homeassistant() -> Map<String, Value> {
        json!({
            "agent": "enabled=1", "bios": "ovmf", "boot": "order=scsi0", "cores": 4, "cpu": "host",
            "description": "Home Assistant", "digest": "f251468035", "efidisk0": "ceph-ssd:vm-107-disk-0,efitype=4m,size=528K",
            "localtime": 1, "machine": "q35", "memory": "8192", "name": "homeassistant",
            "net0": "virtio=02:1E:37:52:EA:4F,bridge=vmbr0", "onboot": 1, "ostype": "l26",
            "scsi0": "ceph-ssd:vm-107-disk-1,discard=on,size=64G,ssd=1", "scsihw": "virtio-scsi-pci",
            "serial0": "socket", "smbios1": "uuid=e8d93e63-38af-4f4f-9c0c-0ea688130c6e", "sockets": 1,
            "tablet": 0, "tags": "community-script;ha", "usb0": "host=1a86:7523"
        })
        .as_object()
        .unwrap()
        .clone()
    }

    #[test]
    fn windows_guests_default_to_local_time() {
        let win = json!({ "ostype": "win11", "name": "rm-server" });
        assert!(parse(win.as_object().unwrap(), &BTreeMap::new()).localtime);
        let win_utc = json!({ "ostype": "win11", "localtime": 0 });
        assert!(!parse(win_utc.as_object().unwrap(), &BTreeMap::new()).localtime);
        assert!(is_windows("w2k8") && is_windows("win10") && !is_windows("l26") && !is_windows("other"));
    }

    #[test]
    fn property_strings() {
        let p = Props::parse("ceph-ssd:vm-107-disk-1,discard=on,size=64G,ssd=1");
        assert_eq!(p.head.as_deref(), Some("ceph-ssd:vm-107-disk-1"));
        assert_eq!(p.get("size"), Some("64G"));
        assert!(p.flag("ssd"));
        assert_eq!(Props::parse("order=scsi0;net0").get("order"), Some("scsi0;net0"));
    }

    #[test]
    fn sizes() {
        assert_eq!(parse_size("64G"), Some(64 << 30));
        assert_eq!(parse_size("528K"), Some(528 << 10));
        assert_eq!(parse_size("4M"), Some(4 << 20));
        assert_eq!(parse_size("1.5G"), Some(1_610_612_736));
        assert_eq!(parse_size("1048576"), Some(1_048_576));
        assert_eq!(parse_size("12Q"), None);
    }

    #[test]
    fn a_real_vm() {
        let sizes = BTreeMap::from([("ceph-ssd:vm-107-disk-1".to_string(), 68_719_476_736u64)]);
        let vm = parse(&homeassistant(), &sizes);
        assert_eq!(vm.name, "homeassistant");
        assert_eq!((vm.bios.as_str(), vm.machine.as_str()), ("ovmf", "q35"));
        assert_eq!((vm.sockets, vm.cores, vm.memory_mib), (1, 4, 8192));
        assert_eq!(vm.cpu_type, "host");
        assert!(vm.agent && vm.onboot && vm.serial_console && vm.localtime && !vm.tablet);
        assert!(vm.efi_disk && !vm.secure_boot);
        assert_eq!(vm.tags, vec!["community-script", "ha"]);
        assert_eq!(vm.boot_order, vec!["scsi0"]);
        assert_eq!(vm.smbios.uuid.as_deref(), Some("e8d93e63-38af-4f4f-9c0c-0ea688130c6e"));

        assert_eq!(vm.disks.len(), 1, "the EFI vars disk is not a disk to import");
        let disk = &vm.disks[0];
        assert_eq!((disk.key.as_str(), disk.bus.as_str(), disk.media.as_str()), ("scsi0", "scsi", "disk"));
        assert_eq!(disk.volid.as_deref(), Some("ceph-ssd:vm-107-disk-1"));
        assert_eq!(disk.size_bytes, Some(68_719_476_736));
        assert!(disk.importable && disk.discard && disk.ssd);

        assert_eq!(vm.nics.len(), 1);
        assert_eq!(vm.nics[0].model, "virtio");
        assert_eq!(vm.nics[0].mac.as_deref(), Some("02:1E:37:52:EA:4F"));
        assert_eq!(vm.nics[0].bridge.as_deref(), Some("vmbr0"));

        assert_eq!(vm.usb, vec![UsbPassthrough { key: "usb0".into(), host: "1a86:7523".into() }]);
        assert!(vm.not_imported.iter().any(|n| n.starts_with("efidisk0")));
    }

    #[test]
    fn defaults_and_odd_devices() {
        let config = json!({
            "name": "legacy", "memory": 2048, "boot": "cdn", "bootdisk": "ide0",
            "ide0": "local-lvm:vm-9-disk-0,size=10G", "ide2": "none,media=cdrom",
            "sata1": "local:iso/debian.iso,media=cdrom,size=600M",
            "virtio2": "/dev/disk/by-id/ata-XYZ,size=1T", "ide3": "local-lvm:vm-9-cloudinit,media=cdrom",
            "net0": "model=e1000,macaddr=AA:BB:CC:DD:EE:FF,bridge=vmbr1,tag=20,firewall=1,link_down=1",
            "hostpci0": "0000:01:00.0", "tpmstate0": "local-lvm:vm-9-disk-2,size=4M,version=v2.0",
            "efidisk0": "local-lvm:vm-9-disk-1,efitype=4m,pre-enrolled-keys=1,size=4M",
            "smbios1": "uuid=u,base64=1,serial=c2VyaWFsLTE=", "parent": "before-upgrade", "unused0": "local-lvm:vm-9-disk-5"
        });
        let vm = parse(config.as_object().unwrap(), &BTreeMap::new());
        assert_eq!(vm.machine, "i440fx", "no machine key means Proxmox's i440fx default");
        assert_eq!(vm.bios, "seabios");
        assert_eq!(vm.cpu_type, "kvm64");
        assert_eq!(vm.boot_order, vec!["ide0"]);
        assert!(vm.secure_boot && vm.tpm && vm.cloud_init && vm.has_snapshots);
        assert_eq!(vm.smbios.serial.as_deref(), Some("serial-1"));

        let keys: Vec<&str> = vm.disks.iter().map(|d| d.key.as_str()).collect();
        assert_eq!(keys, vec!["ide0", "ide2", "sata1", "virtio2"]);
        let by = |k: &str| vm.disks.iter().find(|d| d.key == k).unwrap();
        assert!(by("ide0").importable);
        assert_eq!(by("ide0").size_bytes, Some(10 << 30));
        assert!(!by("ide2").importable);
        assert!(by("sata1").importable && by("sata1").media == "cdrom");
        assert!(!by("virtio2").importable && by("virtio2").note.as_deref().unwrap().contains("/dev/disk/by-id"));

        let nic = &vm.nics[0];
        assert_eq!((nic.model.as_str(), nic.mac.as_deref(), nic.vlan), ("e1000", Some("AA:BB:CC:DD:EE:FF"), Some(20)));
        assert!(nic.firewall && nic.link_down);
        assert!(!vm.localtime, "a Linux guest keeps UTC unless localtime is set");
        assert!(vm.not_imported.iter().any(|n| n.starts_with("hostpci0")));
        assert!(vm.not_imported.iter().any(|n| n.starts_with("unused0")));
    }
}
