// Dev check: build VMs for each boot source and dry-run them against the API
// server through a local gateway. Run with:
//   npx tsx src/plugins/core/create/vmBuilder.dryrun.ts ws://127.0.0.1:8016/ws <namespace>
import { buildVm, defaultModel, type VmModel } from './vmBuilder'

// Runs under Node, outside the browser build's types.
declare const process: { argv: string[]; exit(code: number): never }

const url = process.argv[2] ?? 'ws://127.0.0.1:8016/ws'
const namespace = process.argv[3] ?? 'kubevirt-webgui-test'

const cases: Array<[string, Partial<VmModel>]> = [
  ['container', { name: 'dry-container', source: 'container', disks: [] }],
  ['url', { name: 'dry-url', source: 'url', url: 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2', ciPassword: 'secret' }],
  ['blank-pxe', { name: 'dry-pxe', source: 'blank', cloudInit: false }],
  ['windows-iso', { name: 'dry-win', source: 'iso', osType: 'windows', iso: { namespace, name: 'some-iso', sizeGib: 6 }, firmware: 'uefi', secureBoot: true, tpm: true, cloudInit: false, nicModel: 'e1000e', disks: [{ size: 64, storageClass: null, bus: 'sata', cache: '', accessMode: null, volumeMode: null }] }],
  ['instancetype', { name: 'dry-it', source: 'container', disks: [], useInstancetype: true, instancetype: 'u1.small', preference: '' }],
]

const ws = new WebSocket(url)
let seq = 0
const pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>()
const call = (method: string, params: object) =>
  new Promise<any>((resolve, reject) => {
    const id = String(++seq)
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, op: 'call', method, params }))
  })

ws.onmessage = async (event) => {
  const frame = JSON.parse(String(event.data))
  if (frame.op === 'hello') {
    await call('auth.login', { method: 'server' })
    let failures = 0
    for (const [label, overrides] of cases) {
      const model = { ...defaultModel(namespace), ...overrides } as VmModel
      const { vm, extraObjects } = buildVm(model)
      try {
        await call('resource.create', { apiVersion: 'kubevirt.io/v1', resource: 'virtualmachines', namespace, body: vm, dryRun: true })
        for (const o of extraObjects) await call('resource.create', { apiVersion: 'v1', resource: 'secrets', namespace, body: o, dryRun: true })
        console.log(`ok    ${label}`)
      } catch (e: any) {
        failures++
        console.log(`FAIL  ${label}: ${e.message}`)
      }
    }
    process.exit(failures ? 1 : 0)
  }
  const p = pending.get(frame.id)
  if (frame.op === 'result') p?.resolve(frame.result)
  else if (frame.op === 'error') p?.reject(frame.error)
}
