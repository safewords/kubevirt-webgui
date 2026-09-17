/**
 * Test VMs. A CPU model every node supports (Westmere) keeps them
 * live-migratable on a cluster with mixed host CPUs.
 */

export const CIRROS = 'quay.io/kubevirt/cirros-container-disk-demo'
export const FEDORA = 'quay.io/containerdisks/fedora:latest'

export function vmManifest(namespace, name, options = {}) {
  const {
    image = CIRROS,
    memory = '256Mi',
    running = false,
    cloudInit = null,
    clientPassthrough = false,
    extraDisks = [],
    extraVolumes = [],
    dataVolumeTemplates = [],
    cpuModel = 'Westmere',
    labels = {},
  } = options
  const disks = [{ name: 'root', disk: { bus: 'virtio' } }]
  const volumes = [{ name: 'root', containerDisk: { image } }]
  if (cloudInit) {
    disks.push({ name: 'cloudinitdisk', disk: { bus: 'virtio' } })
    volumes.push({ name: 'cloudinitdisk', cloudInitNoCloud: { userData: cloudInit } })
  }
  return {
    apiVersion: 'kubevirt.io/v1',
    kind: 'VirtualMachine',
    metadata: { name, namespace, labels: { 'kubevirt-webgui/e2e': 'true', ...labels } },
    spec: {
      runStrategy: running ? 'Always' : 'Halted',
      dataVolumeTemplates,
      template: {
        metadata: { labels: { 'kubevirt.io/vm': name } },
        spec: {
          domain: {
            cpu: { cores: 1, model: cpuModel },
            memory: { guest: memory },
            devices: {
              disks: [...disks, ...extraDisks],
              interfaces: [{ name: 'default', masquerade: {} }],
              ...(clientPassthrough ? { clientPassthrough: {} } : {}),
            },
          },
          networks: [{ name: 'default', pod: {} }],
          terminationGracePeriodSeconds: 30,
          volumes: [...volumes, ...extraVolumes],
        },
      },
    },
  }
}

/** Fedora with the guest agent, for soft reboot and agent-backed features. */
export const FEDORA_AGENT_CLOUD_INIT = `#cloud-config
password: e2e-password
chpasswd:
  expire: false
packages:
  - qemu-guest-agent
runcmd:
  - [systemctl, enable, --now, qemu-guest-agent]
`

/** Create a VM through the gateway (the `vm.create` task) and optionally start it. */
export async function createVm(gw, namespace, name, options = {}) {
  const vm = vmManifest(namespace, name, options)
  await gw.runTask('vm.create', { vm, start: false })
  if (options.start) await gw.runTask('vm.start', { namespace, name }, 10 * 60_000)
  return vm
}
