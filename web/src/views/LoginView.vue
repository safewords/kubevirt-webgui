<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { faKey, faRightToBracket, faServer, faCircleInfo, faEye, faEyeSlash, faFileImport } from '@fortawesome/free-solid-svg-icons'
import { load } from 'js-yaml'
import { useSession } from '@/stores/session'
import { errorMessage } from '@/api/gateway'
import Notice from '@/components/ui/Notice.vue'

const session = useSession()
const router = useRouter()
const route = useRoute()

const realm = ref<'token' | 'server'>('token')
const token = ref('')
const show = ref(false)
const busy = ref(false)
const error = ref<string | null>(null)
const methods = computed(() => session.hello?.auth.methods ?? ['token'])

// A slow socket can resume a stored session after this screen appeared.
watch(
  () => session.status,
  (status) => {
    if (status === 'authenticated' && !busy.value) {
      const next = typeof route.query.next === 'string' && route.query.next.startsWith('/') ? route.query.next : '/'
      router.replace(next)
    }
  },
)

/** Token-based users found in a kubeconfig the person picked. Read in the
 * browser only; nothing but the chosen token is sent, and only on sign-in. */
const kubeconfigUsers = ref<Array<{ context: string; user: string; token: string }>>([])
const fileInput = ref<HTMLInputElement | null>(null)

async function readKubeconfig(event: Event) {
  error.value = null
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    const config = load(await file.text()) as any
    const users = new Map<string, string>((config?.users ?? []).filter((u: any) => u?.user?.token).map((u: any) => [u.name, u.user.token]))
    kubeconfigUsers.value = (config?.contexts ?? [])
      .filter((c: any) => users.has(c?.context?.user))
      .map((c: any) => ({ context: c.name, user: c.context.user, token: users.get(c.context.user)! }))
    if (!kubeconfigUsers.value.length) {
      error.value = 'That kubeconfig has no token-based users. Client certificates and exec plugins cannot be used here; create a token with kubectl create token.'
    } else {
      const current = kubeconfigUsers.value.find((u) => u.context === config['current-context']) ?? kubeconfigUsers.value[0]
      token.value = current.token
    }
  } catch (e) {
    error.value = `Could not read the kubeconfig: ${errorMessage(e)}`
  } finally {
    if (fileInput.value) fileInput.value.value = ''
  }
}

async function submit() {
  error.value = null
  busy.value = true
  try {
    if (realm.value === 'server') await session.loginAsServer()
    else await session.login(token.value)
    const next = typeof route.query.next === 'string' && route.query.next.startsWith('/') ? route.query.next : '/'
    router.replace(next)
  } catch (e) {
    error.value = errorMessage(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex min-h-full items-center justify-center bg-surface-0 p-4">
    <div class="w-full max-w-[460px]">
      <div class="mb-5 flex items-center justify-center gap-3">
        <img src="/favicon.svg" class="size-10" alt="" />
        <div>
          <div class="text-lg font-semibold">{{ session.hello?.server.product ?? 'kubevirt-webgui' }}</div>
          <div class="text-xs text-fg-muted">{{ session.hello?.server.cluster ?? 'connecting…' }}</div>
        </div>
      </div>
      <form class="card overflow-hidden" @submit.prevent="submit">
        <div class="card-header"><Fa :icon="faRightToBracket" class="text-accent" /> Sign in with your cluster credentials</div>
        <div class="space-y-3 p-4">
          <Notice v-if="error ?? session.lastError" kind="error">{{ error ?? session.lastError }}</Notice>
          <div>
            <label class="label">Realm</label>
            <select v-model="realm" class="input">
              <option value="token">Kubernetes token (ServiceAccount or OIDC)</option>
              <option v-if="methods.includes('server')" value="server">Server identity (local kubeconfig)</option>
            </select>
          </div>
          <div v-if="realm === 'token'">
            <div class="mb-1 flex items-center justify-between">
              <label class="label mb-0">Bearer token</label>
              <button type="button" class="btn btn-ghost btn-sm" title="Pick a token from a kubeconfig file (read locally)" @click="fileInput?.click()">
                <Fa :icon="faFileImport" /> From kubeconfig
              </button>
              <input ref="fileInput" type="file" class="hidden" @change="readKubeconfig" />
            </div>
            <select v-if="kubeconfigUsers.length > 1" class="input mb-2" @change="token = kubeconfigUsers[($event.target as HTMLSelectElement).selectedIndex].token">
              <option v-for="u in kubeconfigUsers" :key="u.context" :selected="u.token === token">context {{ u.context }} (user {{ u.user }})</option>
            </select>
            <div class="relative">
              <textarea
                v-model="token"
                class="input mono h-24 resize-none pr-8"
                :class="show ? '' : '[-webkit-text-security:disc]'"
                placeholder="eyJhbGciOi…"
                autocomplete="off"
                spellcheck="false"
                autofocus
                @keydown.enter.exact.prevent="submit"
              />
              <button type="button" class="absolute top-1.5 right-2 text-fg-subtle hover:text-fg" :title="show ? 'Hide' : 'Show'" @click="show = !show">
                <Fa :icon="show ? faEyeSlash : faEye" />
              </button>
            </div>
            <p class="mt-2 flex gap-1.5 text-xs text-fg-muted">
              <Fa :icon="faCircleInfo" class="mt-0.5" />
              <span>
                Your token goes only to this server, which calls the Kubernetes API as you — RBAC decides what you can do. Create one with
                <code class="mono rounded bg-surface-3 px-1">kubectl create token &lt;serviceaccount&gt; -n &lt;namespace&gt; --duration=8h</code>
              </span>
            </p>
          </div>
          <Notice v-else kind="warning" title="Single-user mode">
            You will act as the identity in the server's kubeconfig. Only use this on your own machine.
          </Notice>
        </div>
        <div class="flex justify-end gap-2 border-t border-line bg-surface-2 px-4 py-2.5">
          <button type="submit" class="btn btn-primary" :disabled="busy || (realm === 'token' && !token.trim())">
            <Fa :icon="realm === 'server' ? faServer : faKey" />
            {{ busy ? 'Signing in…' : 'Sign in' }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
