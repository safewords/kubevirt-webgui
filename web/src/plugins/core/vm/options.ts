/** The Options table: VM-wide settings, each edited in a small dialog. */
import {
  faNoteSticky, faTags, faPowerOff, faPersonWalkingArrowRight, faListOl, faHourglassHalf, faLocationDot,
  faDiagramProject, faIdCard, faGaugeSimpleHigh, faPause, faFlag, faHandHoldingHeart,
} from '@fortawesome/free-solid-svg-icons'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import type { ObjectContext } from '@/plugins/registry'
import { openDialog, toast } from '@/services/dialogs'
import { NOTES_ANNOTATION, runStrategy, tags } from '@/util/kubevirt'
import FormDialog from './FormDialog.vue'
import TagsDialog from './TagsDialog.vue'
import BootOrderDialog from './BootOrderDialog.vue'
import PlacementDialog from './PlacementDialog.vue'
import YamlDialog from './YamlDialog.vue'
import { disksOf, interfacesOf, validQuantity } from './spec'
import { updateTemplate, updateVm } from './update'

export interface OptionRow {
  id: string
  icon: IconDefinition
  label: string
  value: string
  edit: (ctx: ObjectContext) => unknown
}

const saved = (what: string) => toast('success', what, 'Saved')

export async function editNotes(ctx: ObjectContext) {
  const result = await openDialog(FormDialog, {
    title: 'Notes',
    icon: faNoteSticky,
    width: '640px',
    initial: { notes: ctx.object?.metadata.annotations?.[NOTES_ANNOTATION] ?? '' },
    fields: [{ key: 'notes', label: 'Notes', type: 'textarea', placeholder: 'What this VM is for, who owns it, how to reach it…', hint: 'Shown on the summary. Stored as an annotation on the VM.' }],
    submit: (v: Record<string, any>) => updateVm(ctx, () => ({ metadata: { annotations: { [NOTES_ANNOTATION]: v.notes.trim() ? v.notes : null } } })),
  })
  if (result) saved('Notes')
}

export async function editTags(ctx: ObjectContext) {
  const result = await openDialog(TagsDialog, { ctx })
  if (result) saved('Tags')
}

async function editRunStrategy(ctx: ObjectContext) {
  const current = runStrategy(ctx.object)
  const result = await openDialog(FormDialog, {
    title: 'Run strategy',
    icon: faPowerOff,
    initial: { strategy: current === '—' ? 'Halted' : current },
    fields: [
      {
        key: 'strategy',
        label: 'Run strategy',
        type: 'select',
        options: [
          { value: 'Always', label: 'Always — keep it running (start at boot, restart on failure)' },
          { value: 'RerunOnFailure', label: 'RerunOnFailure — restart only if it fails' },
          { value: 'Once', label: 'Once — run to completion, never restart' },
          { value: 'Manual', label: 'Manual — only started and stopped by hand' },
          { value: 'Halted', label: 'Halted — keep it stopped' },
        ],
      },
    ],
    description: 'Always and Halted start or stop the VM as soon as they are saved.',
    submit: (v: Record<string, any>) => updateVm(ctx, () => ({ spec: { runStrategy: v.strategy, running: null } })),
  })
  if (result) saved('Run strategy')
}

async function editEviction(ctx: ObjectContext) {
  const result = await openDialog(FormDialog, {
    title: 'Eviction strategy',
    icon: faPersonWalkingArrowRight,
    initial: { strategy: ctx.object?.spec?.template?.spec?.evictionStrategy ?? '' },
    fields: [
      {
        key: 'strategy',
        label: 'When its node is drained',
        type: 'select',
        options: [
          { value: '', label: 'Cluster default' },
          { value: 'LiveMigrate', label: 'LiveMigrate — move it, block the drain if it cannot' },
          { value: 'LiveMigrateIfPossible', label: 'LiveMigrateIfPossible — move it, else shut it down' },
          { value: 'External', label: 'External — let an outside controller decide' },
          { value: 'None', label: 'None — shut it down' },
        ],
      },
    ],
    submit: (v: Record<string, any>) => updateTemplate(ctx, () => ({ evictionStrategy: v.strategy || null })),
  })
  if (result) saved('Eviction strategy')
}

async function editGrace(ctx: ObjectContext) {
  const result = await openDialog(FormDialog, {
    title: 'Shutdown timeout',
    icon: faHourglassHalf,
    initial: { seconds: ctx.object?.spec?.template?.spec?.terminationGracePeriodSeconds ?? '' },
    fields: [
      {
        key: 'seconds',
        label: 'Grace period',
        type: 'number',
        min: 0,
        unit: 'seconds',
        placeholder: '180 (default)',
        hint: 'How long a shutdown waits for the guest before pulling the plug.',
        validate: (v: any) => (v === '' || Number(v) >= 0 ? null : 'Zero or more'),
      },
    ],
    submit: (v: Record<string, any>) => updateTemplate(ctx, () => ({ terminationGracePeriodSeconds: v.seconds === '' ? null : Number(v.seconds) })),
  })
  if (result) saved('Shutdown timeout')
}

async function editHostname(ctx: ObjectContext) {
  const spec = ctx.object?.spec?.template?.spec ?? {}
  const result = await openDialog(FormDialog, {
    title: 'Hostname',
    icon: faIdCard,
    initial: { hostname: spec.hostname ?? '', subdomain: spec.subdomain ?? '' },
    fields: [
      { key: 'hostname', label: 'Hostname', type: 'text', placeholder: ctx.name, validate: (v: string) => (!v || /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(v) ? null : 'A DNS label') },
      { key: 'subdomain', label: 'Subdomain', type: 'text', placeholder: 'none', hint: 'With a headless service of the same name, gives the VM <hostname>.<subdomain>.<namespace>.svc.' },
    ],
    submit: (v: Record<string, any>) => updateTemplate(ctx, () => ({ hostname: v.hostname.trim() || null, subdomain: v.subdomain.trim() || null })),
  })
  if (result) saved('Hostname')
}

async function editOvercommit(ctx: ObjectContext) {
  const domain = ctx.object?.spec?.template?.spec?.domain ?? {}
  const result = await openDialog(FormDialog, {
    title: 'Resource requests and limits',
    icon: faGaugeSimpleHigh,
    initial: {
      cpuRequest: domain.resources?.requests?.cpu ?? '',
      cpuLimit: domain.resources?.limits?.cpu ?? '',
      memoryRequest: domain.resources?.requests?.memory ?? '',
      memoryLimit: domain.resources?.limits?.memory ?? '',
    },
    description: 'What the scheduler reserves on the node, separately from what the guest sees. Requests below the guest size overcommit the node.',
    fields: [
      { key: 'cpuRequest', label: 'CPU request', type: 'text', placeholder: 'derived from vCPUs', validate: (v: string) => (v ? validQuantity(v) : null) },
      { key: 'cpuLimit', label: 'CPU limit', type: 'text', placeholder: 'none', validate: (v: string) => (v ? validQuantity(v) : null) },
      { key: 'memoryRequest', label: 'Memory request', type: 'text', placeholder: 'guest memory', validate: (v: string) => (v ? validQuantity(v) : null) },
      { key: 'memoryLimit', label: 'Memory limit', type: 'text', placeholder: 'none', validate: (v: string) => (v ? validQuantity(v) : null) },
    ],
    submit: (v: Record<string, any>) =>
      updateTemplate(ctx, () => ({
        domain: {
          resources: {
            requests: { cpu: v.cpuRequest.trim() || null, memory: v.memoryRequest.trim() || null },
            limits: { cpu: v.cpuLimit.trim() || null, memory: v.memoryLimit.trim() || null },
          },
        },
      })),
  })
  if (result) saved('Resources')
}

async function editStartStrategy(ctx: ObjectContext) {
  const result = await openDialog(FormDialog, {
    title: 'Start paused',
    icon: faPause,
    initial: { paused: ctx.object?.spec?.template?.spec?.startStrategy === 'Paused' },
    fields: [{ key: 'paused', label: 'Start the VM paused', type: 'checkbox', hint: 'Handy for attaching a debugger or console before the guest runs.' }],
    submit: (v: Record<string, any>) => updateTemplate(ctx, () => ({ startStrategy: v.paused ? 'Paused' : null })),
  })
  if (result) saved('Start strategy')
}

async function editPriority(ctx: ObjectContext) {
  const result = await openDialog(FormDialog, {
    title: 'Priority class',
    icon: faFlag,
    initial: { name: ctx.object?.spec?.template?.spec?.priorityClassName ?? '' },
    fields: [{ key: 'name', label: 'Priority class name', type: 'text', placeholder: 'none', hint: 'Higher-priority guests can preempt lower ones when a node is full.' }],
    submit: (v: Record<string, any>) => updateTemplate(ctx, () => ({ priorityClassName: v.name.trim() || null })),
  })
  if (result) saved('Priority class')
}

function yamlEditor(field: 'affinity' | 'tolerations', title: string, description: string) {
  return async (ctx: ObjectContext) => {
    const result = await openDialog(YamlDialog, {
      title,
      description,
      value: ctx.object?.spec?.template?.spec?.[field] ?? null,
      // Replace, not merge: null the field first so removed rules go away.
      submit: async (value: unknown) => {
        await updateTemplate(ctx, () => ({ [field]: null }))
        if (value !== null) await updateTemplate(ctx, () => ({ [field]: value }))
      },
    })
    if (result) saved(title)
  }
}

function summarizeSelector(selector: Record<string, string> | undefined): string {
  const entries = Object.entries(selector ?? {})
  if (!entries.length) return 'any node'
  if (entries.length === 1 && entries[0][0] === 'kubernetes.io/hostname') return `pinned to ${entries[0][1]}`
  return entries.map(([k, v]) => `${k}=${v}`).join(', ')
}

function bootOrderSummary(spec: any): string {
  const items = [
    ...disksOf(spec).filter((d) => d.bootOrder).map((d) => ({ name: d.name, order: d.bootOrder })),
    ...interfacesOf(spec).filter((i) => i.bootOrder).map((i) => ({ name: `${i.name} (network)`, order: i.bootOrder })),
  ].sort((a, b) => a.order - b.order)
  return items.length ? items.map((i) => i.name).join(', ') : 'firmware default'
}

export function optionRows(ctx: ObjectContext): OptionRow[] {
  const vm = ctx.object
  const spec = vm?.spec?.template?.spec ?? {}
  const resources = spec.domain?.resources ?? {}
  const notes = vm?.metadata.annotations?.[NOTES_ANNOTATION] ?? ''
  return [
    { id: 'name', icon: faIdCard, label: 'Name', value: `${ctx.namespace}/${ctx.name}`, edit: () => toast('info', 'Name', 'Kubernetes names cannot be changed; clone the VM to give it a new one.') },
    { id: 'notes', icon: faNoteSticky, label: 'Notes', value: notes ? notes.split('\n')[0] + (notes.includes('\n') ? ' …' : '') : 'none', edit: editNotes },
    { id: 'tags', icon: faTags, label: 'Tags', value: tags(vm).join(', ') || 'none', edit: editTags },
    { id: 'run', icon: faPowerOff, label: 'Run strategy (start at boot)', value: runStrategy(vm), edit: editRunStrategy },
    { id: 'eviction', icon: faPersonWalkingArrowRight, label: 'Eviction strategy', value: spec.evictionStrategy ?? 'cluster default', edit: editEviction },
    { id: 'boot', icon: faListOl, label: 'Boot order', value: bootOrderSummary(spec), edit: (c) => openDialog(BootOrderDialog, { ctx: c }).then((r) => r && saved('Boot order')) },
    { id: 'grace', icon: faHourglassHalf, label: 'Shutdown timeout', value: spec.terminationGracePeriodSeconds !== undefined ? `${spec.terminationGracePeriodSeconds}s` : 'default (180s)', edit: editGrace },
    { id: 'placement', icon: faLocationDot, label: 'Node placement', value: summarizeSelector(spec.nodeSelector), edit: (c) => openDialog(PlacementDialog, { ctx: c }).then((r) => r && saved('Node placement')) },
    {
      id: 'affinity',
      icon: faDiagramProject,
      label: 'Affinity',
      value: spec.affinity ? Object.keys(spec.affinity).join(', ') : 'none',
      edit: yamlEditor('affinity', 'Affinity', 'Node and pod (anti-)affinity rules, as in a pod spec — e.g. keep two replicas of a service on different nodes.'),
    },
    {
      id: 'tolerations',
      icon: faHandHoldingHeart,
      label: 'Tolerations',
      value: spec.tolerations?.length ? `${spec.tolerations.length} rule${spec.tolerations.length === 1 ? '' : 's'}` : 'none',
      edit: yamlEditor('tolerations', 'Tolerations', 'A list of tolerations, as in a pod spec, to run on tainted nodes.'),
    },
    { id: 'hostname', icon: faIdCard, label: 'Hostname', value: `${spec.hostname ?? ctx.name}${spec.subdomain ? `.${spec.subdomain}` : ''}`, edit: editHostname },
    {
      id: 'resources',
      icon: faGaugeSimpleHigh,
      label: 'Requests / limits',
      value:
        [
          resources.requests?.cpu ? `cpu request ${resources.requests.cpu}` : null,
          resources.limits?.cpu ? `cpu limit ${resources.limits.cpu}` : null,
          resources.requests?.memory ? `memory request ${resources.requests.memory}` : null,
          resources.limits?.memory ? `memory limit ${resources.limits.memory}` : null,
        ]
          .filter(Boolean)
          .join(', ') || 'derived from the guest size',
      edit: editOvercommit,
    },
    { id: 'start', icon: faPause, label: 'Start paused', value: spec.startStrategy === 'Paused' ? 'yes' : 'no', edit: editStartStrategy },
    { id: 'priority', icon: faFlag, label: 'Priority class', value: spec.priorityClassName ?? 'none', edit: editPriority },
  ]
}
