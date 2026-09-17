<script setup lang="ts">
/** Mint a ServiceAccount token, shown once — Proxmox's "API token" dialog. */
import { computed, ref } from 'vue'
import { faKey, faCopy, faTriangleExclamation, faTerminal } from '@fortawesome/free-solid-svg-icons'
import Modal from '@/components/ui/Modal.vue'
import Notice from '@/components/ui/Notice.vue'
import { gateway, errorMessage } from '@/api/gateway'
import { toast } from '@/services/dialogs'
import { dateTime } from '@/util/format'
import { copyText } from '@/util/clipboard'

const props = defineProps<{ namespace: string; name: string; server?: string }>()
const emit = defineEmits<{ close: [] }>()

const EXPIRY = [
  { label: '1 hour', seconds: 3600 },
  { label: '8 hours', seconds: 8 * 3600 },
  { label: '1 day', seconds: 86400 },
  { label: '7 days', seconds: 7 * 86400 },
  { label: '30 days', seconds: 30 * 86400 },
  { label: '90 days', seconds: 90 * 86400 },
  { label: '1 year', seconds: 365 * 86400 },
]
const expiration = ref(8 * 3600)
const token = ref<string | null>(null)
const expires = ref<string | null>(null)
const error = ref<string | null>(null)
const busy = ref(false)

async function create() {
  error.value = null
  busy.value = true
  try {
    const result = await gateway.call<{ token: string; expires: string }>('serviceaccount.token', { namespace: props.namespace, name: props.name, expirationSeconds: expiration.value })
    token.value = result.token
    expires.value = result.expires
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}

async function copy(text: string, what: string) {
  if (await copyText(text)) toast('success', `${what} copied`)
  else toast('error', 'Could not copy', 'The browser blocked clipboard access; select the token in the field and copy it manually.')
}

const kubeconfigSnippet = computed(() =>
  token.value
    ? `kubectl config set-credentials ${props.name}@${props.namespace} --token=<paste token>\nkubectl config set-context ${props.name}@${props.namespace} --cluster=<cluster> --user=${props.name}@${props.namespace} --namespace=${props.namespace}`
    : '',
)
</script>

<template>
  <Modal :title="`Token for ${namespace}/${name}`" :icon="faKey" width="620px" @close="emit('close')">
    <div class="space-y-3">
      <Notice v-if="error" kind="error">{{ error }}</Notice>
      <template v-if="!token">
        <p class="text-fg-muted">
          The cluster issues a bound token for this ServiceAccount. It grants whatever the ServiceAccount's role bindings grant, until it expires; it cannot be listed or revoked individually — delete the ServiceAccount to revoke every token.
        </p>
        <div>
          <label class="label">Expires after</label>
          <select v-model.number="expiration" class="input w-48">
            <option v-for="e in EXPIRY" :key="e.seconds" :value="e.seconds">{{ e.label }}</option>
          </select>
        </div>
      </template>
      <template v-else>
        <Notice kind="warning" title="Copy the token now">
          <Fa :icon="faTriangleExclamation" /> It is not stored anywhere and will not be shown again.
        </Notice>
        <div>
          <label class="label">Token (expires {{ dateTime(expires) }})</label>
          <div class="flex gap-2">
            <textarea readonly class="input mono h-28 resize-none break-all" :value="token" @focus="($event.target as HTMLTextAreaElement).select()" />
            <button class="btn" @click="copy(token!, 'Token')"><Fa :icon="faCopy" /> Copy</button>
          </div>
        </div>
        <div>
          <label class="label"><Fa :icon="faTerminal" /> Use it with kubectl</label>
          <pre class="mono overflow-auto rounded-md border border-line bg-surface-0 p-2 text-xs">{{ kubeconfigSnippet }}</pre>
        </div>
        <p class="text-xs text-fg-muted">The same token signs in to this GUI.</p>
      </template>
    </div>
    <template #footer>
      <button class="btn" @click="emit('close')">{{ token ? 'Done' : 'Cancel' }}</button>
      <button v-if="!token" class="btn btn-primary" :disabled="busy" @click="create"><Fa :icon="faKey" /> {{ busy ? 'Creating…' : 'Create token' }}</button>
    </template>
  </Modal>
</template>
