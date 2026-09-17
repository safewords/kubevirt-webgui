// Import from Proxmox, end to end, through the browser: sign in to a Proxmox
// VE node with an SSH key, confirm its host key, pick a stopped VM on another
// node (its disks are read there through the cluster's SSH), import it, and
// check that the VM boots from the copied disk and a data disk arrives byte
// for byte.
//
// The test makes its own throwaway Proxmox VM (E2E_PROXMOX_VMID, default
// 9901, on E2E_PROXMOX_VM_NODE) and destroys it afterwards. Nothing else on
// Proxmox is touched: other VMs are only listed.
//
//   E2E_PROXMOX_HOST       the node the GUI signs in to (default 10.0.4.3)
//   E2E_PROXMOX_VM_HOST    the node that holds the test VM, reached by this
//                          test over SSH (default 10.0.4.2 = pve-thin-2)
//   E2E_PROXMOX_KEY_FILE   a private key root accepts (default ~/.ssh/id_ed25519)
//
// The GUI's server must allow the host: PROXMOX_ALLOWED_HOSTS=10.0.4.0/24.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Gateway } from './lib/gateway.mjs'
import { openGui } from './lib/browser.mjs'
import { get, testNamespace, waitFor } from './lib/k8s.mjs'
import { capture, cirrosRun, waitRunning } from './lib/vm.mjs'
import { createMenu, field } from './lib/forms.mjs'
import { keep } from './lib/env.mjs'

const HOST = process.env.E2E_PROXMOX_HOST ?? '10.0.4.3'
const VM_HOST = process.env.E2E_PROXMOX_VM_HOST ?? '10.0.4.2'
const VMID = Number(process.env.E2E_PROXMOX_VMID ?? 9901)
const KEY_FILE = process.env.E2E_PROXMOX_KEY_FILE ?? join(homedir(), '.ssh', 'id_ed25519')
const NAME = 'kve-import-test'
const MAC = 'bc:24:11:aa:bb:01'
const UUID = '6f1b1f2e-9c4e-4c7a-8d8e-2f0a1b2c3d4e'
const CIRROS = 'https://download.cirros-cloud.net/0.6.2/cirros-0.6.2-x86_64-disk.img'

let gw, ns, gui, marker, dataSha

/** Run a script on a Proxmox node as root, from this machine. */
function pve(host, script, timeout = 300_000) {
  return execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', `root@${host}`, script], { encoding: 'utf8', timeout }).trim()
}

before(async () => {
  // A fresh throwaway VM: cirros on local storage (so it must be read on its
  // own node) and a 64 MiB data disk of random bytes on shared Ceph.
  const out = pve(VM_HOST, `set -e
if qm status ${VMID} >/dev/null 2>&1; then
  grep -q 'kubevirt-webgui import tests' /etc/pve/qemu-server/${VMID}.conf || { echo "VM ${VMID} exists and is not the test VM" >&2; exit 9; }
  qm destroy ${VMID} --purge >/dev/null
fi
cd /var/lib/vz/import
[ -s kve-e2e-cirros.qcow2 ] || curl -fsSL -m 120 -o kve-e2e-cirros.qcow2 ${CIRROS}
marker="KVE-IMPORT-MARKER-$(date +%s%N)"
{ printf '%s\\n' "$marker"; head -c 40M /dev/urandom; } > kve-e2e-data.raw
truncate -s 64M kve-e2e-data.raw
qm create ${VMID} --name ${NAME} --memory 512 --cores 1 --sockets 1 --cpu x86-64-v2-AES --machine q35 --ostype l26 \\
  --scsihw virtio-scsi-single --scsi0 local-lvm:0,import-from=local:import/kve-e2e-cirros.qcow2,discard=on,ssd=1 \\
  --virtio1 ceph-ssd:0,import-from=/var/lib/vz/import/kve-e2e-data.raw,serial=kvedata \\
  --net0 virtio=${MAC.toUpperCase()},bridge=vmbr0 --serial0 socket --vga serial0 --boot 'order=scsi0;net0' \\
  --tags 'kve-e2e;throwaway' --description 'Throwaway VM for kubevirt-webgui import tests - safe to delete' \\
  --smbios1 uuid=${UUID} >/dev/null 2>&1
echo "$marker"
sha256sum kve-e2e-data.raw | cut -d' ' -f1`)
  ;[marker, dataSha] = out.split('\n').slice(-2)
  assert.match(marker, /^KVE-IMPORT-MARKER-/)
  assert.match(dataSha, /^[0-9a-f]{64}$/)

  gw = await Gateway.connect()
  ns = await testNamespace(gw, 'pve')
  gui = await openGui()
  await gui.login()
})

after(async () => {
  if (gui) {
    if (gui.errors.length) console.log('browser errors:', gui.errors)
    await gui.close()
  }
  await ns?.cleanup()
  gw?.close()
  if (!keep) {
    try {
      pve(VM_HOST, `grep -q 'kubevirt-webgui import tests' /etc/pve/qemu-server/${VMID}.conf 2>/dev/null && qm destroy ${VMID} --purge >/dev/null; rm -f /var/lib/vz/import/kve-e2e-data.raw /var/lib/vz/import/kve-e2e-cirros.qcow2`)
    } catch (e) {
      console.log(`# could not remove Proxmox VM ${VMID}: ${e.message}`)
    }
  }
})

test('the server refuses hosts outside PROXMOX_ALLOWED_HOSTS, and a host key that does not match', async () => {
  await assert.rejects(gw.call('proxmox.hostKey', { host: '127.0.0.1', port: 22 }), /PROXMOX_ALLOWED_HOSTS/)
  await assert.rejects(
    gw.call('proxmox.connect', { host: HOST, user: 'root', privateKey: readFileSync(KEY_FILE, 'utf8'), fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, 60_000),
    /host key has changed|refusing to send credentials/,
  )
})

test('import a stopped Proxmox VM through the wizard; it boots from the copied disk', { timeout: 30 * 60_000 }, () => capture(gui, 'proxmox-import', async () => {
  const { page } = gui
  await createMenu(page, 'Import from Proxmox')
  const wizard = page.locator('[role=dialog]', { has: page.locator('[data-proxmox-import]') })
  await wizard.waitFor({ timeout: 15_000 })

  // Connect: host key first, then the key.
  await field(wizard, 'Host').fill(HOST)
  await field(wizard, 'User').fill('root')
  await wizard.getByLabel('SSH private key').check()
  await field(wizard, 'Private key').fill(readFileSync(KEY_FILE, 'utf8'))
  await wizard.getByRole('button', { name: 'Check host key' }).click()
  const keyCard = wizard.locator('[data-host-key]')
  await keyCard.waitFor({ timeout: 30_000 })
  const shown = await keyCard.innerText()
  const real = pve(HOST, 'for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done')
  const fingerprint = shown.match(/SHA256:[A-Za-z0-9+/]+/)?.[0]
  assert.ok(fingerprint && real.includes(fingerprint), `the wizard shows one of the host's own keys (${fingerprint})`)
  await keyCard.getByRole('button', { name: /Trust.*connect/ }).click()

  // The VM list: running VMs are listed but cannot be chosen.
  const table = wizard.locator('table')
  const row = table.locator(`tr[data-vmid="${VMID}"]`)
  await row.waitFor({ timeout: 60_000 })
  const running = table.locator('tr', { hasText: 'running — shut it down' })
  console.log(`# ${await table.locator('tbody tr').count()} VMs listed, ${await running.count()} running (not selectable)`)
  await row.click()

  // Settings: the mapping is prefilled from Proxmox.
  await wizard.getByText(`Importing VM ${VMID}`).waitFor({ timeout: 60_000 })
  assert.equal(await field(wizard, 'Name').inputValue(), NAME)
  assert.equal(await field(wizard, 'Memory (MiB)').inputValue(), '512')
  await field(wizard, 'Namespace').fill(ns.name)
  await wizard.getByRole('button', { name: 'Next' }).click()

  // Disks: both copied; the boot disk keeps its SCSI bus.
  for (const key of ['scsi0', 'virtio1']) assert.ok(await wizard.locator(`[data-disk="${key}"] input[type=checkbox]`).first().isChecked(), `${key} is included`)
  await wizard.getByRole('button', { name: 'Next' }).click()
  // Network: net0 on the pod network, keeping its MAC.
  assert.ok(await wizard.locator('[data-nic="net0"] input[type=checkbox]').isChecked(), 'the MAC address is kept')
  await wizard.getByRole('button', { name: 'Next' }).click()

  // Confirm, start once imported.
  await wizard.getByText('What will be created').waitFor()
  await wizard.getByLabel('Start the VM once its disks are in').check()
  await wizard.getByRole('button', { name: 'Import', exact: true }).click()

  const viewer = page.locator('[role=dialog]', { hasText: 'Task viewer' })
  await viewer.waitFor({ timeout: 60_000 })
  const task = [...gw.tasks.values()].filter((t) => t.kind === 'proxmox.import').sort((a, b) => b.startedAt - a.startedAt)[0]
  assert.ok(task, 'the import started a task')
  // The viewer shows a live bar while disks copy.
  await viewer.getByRole('progressbar').first().waitFor({ timeout: 5 * 60_000 })
  const done = await gw.waitTask(task.id, 25 * 60_000)
  console.log(`# ${done.log.filter((l) => /copying|%|GiB|hop|through|proxy/.test(l)).join('\n# ')}`)
  assert.equal(done.status, 'ok', done.log.join('\n'))

  const reports = gw.taskProgress.get(task.id) ?? []
  const total = 117_440_512 + 67_108_864
  console.log(`# ${reports.length} progress reports; last ${JSON.stringify(reports.at(-1))}`)
  assert.ok(reports.length >= 2, 'the task reported progress while copying')
  assert.ok(reports.every((r) => r.unit === 'bytes' && r.total === total), 'progress counts bytes of both disks')
  assert.ok(reports.some((r) => r.done === total), 'progress reached the total')
  assert.ok(done.log.some((l) => l.includes('through the cluster')), 'the disks were read on their own node')

  // The VM, as mapped.
  const vm = await get(gw, { apiVersion: 'kubevirt.io/v1', resource: 'virtualmachines', namespace: ns.name, name: NAME })
  const spec = vm.spec.template.spec
  assert.equal(vm.metadata.annotations['kubevirt-webgui/imported-from'], `proxmox://${HOST}/pve-thin-2/${VMID}`)
  assert.equal(spec.domain.firmware.uuid, UUID)
  assert.equal(spec.domain.memory.guest, '512Mi')
  assert.equal(spec.domain.devices.interfaces[0].macAddress, MAC)
  const disks = Object.fromEntries(spec.domain.devices.disks.map((d) => [d.name, d]))
  assert.deepEqual(disks.scsi0.disk, { bus: 'scsi' })
  assert.equal(disks.scsi0.bootOrder, 1)
  assert.deepEqual(disks.virtio1.disk, { bus: 'virtio' })
  assert.equal(disks.virtio1.serial, 'kvedata')

  // It boots from the copied cirros disk, and the data disk is identical.
  await waitRunning(gw, ns.name, NAME)
  const out = await cirrosRun(gw, ns.name, NAME, 'sudo head -c 64 /dev/vda | head -1; sudo head -c 67108864 /dev/vda | sha256sum', { timeoutMs: 8 * 60_000 })
  console.log(`# guest: ${out.trim().replace(/\s+/g, ' ')}`)
  assert.ok(out.includes(marker), 'the data disk starts with the marker written on Proxmox')
  assert.ok(out.includes(dataSha), 'the data disk has the same SHA-256 as on Proxmox')

  // Proxmox was only read: the source VM is still there, stopped.
  assert.equal(pve(VM_HOST, `qm status ${VMID}`), 'status: stopped')
  await waitFor('the VM page', async () => page.url().includes(`/${NAME}/`), { timeoutMs: 10_000 }).catch(() => {})
}))
