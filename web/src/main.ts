import { createApp, watch } from 'vue'
import { createPinia } from 'pinia'
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import '@fortawesome/fontawesome-svg-core/styles.css'
import { config as faConfig } from '@fortawesome/fontawesome-svg-core'
import './style.css'
import App from './App.vue'
import { router } from './router'
import { gateway } from './api/gateway'
import { useSession } from './stores/session'
import { exposeApi, loadPlugins } from './plugins/loader'
import { registerConfirmComponent, registerTaskLogOpener, openDialog } from './services/dialogs'
import ConfirmDialog from './components/ui/ConfirmDialog.vue'
import TaskLogDialog from './components/layout/TaskLogDialog.vue'

// The stylesheet is imported above; don't inject it at runtime (CSP).
faConfig.autoAddCss = false

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
app.component('Fa', FontAwesomeIcon)

const session = useSession()
gateway.onOpen = async () => {
  await session.resume()
}
gateway.onSessionExpired = () => {
  session.expired()
  router.push({ name: 'login', query: { next: router.currentRoute.value.fullPath } })
}

registerConfirmComponent(ConfirmDialog)
registerTaskLogOpener((id) => openDialog(TaskLogDialog, { id }))
exposeApi()

// Plugins need the cluster's capabilities, which need a signed-in user.
watch(
  () => session.status,
  (status) => {
    if (status === 'authenticated') loadPlugins()
  },
  { immediate: true },
)

app.use(router)
gateway.connect()
app.mount('#app')
document.getElementById('app')?.setAttribute('data-mounted', 'true')
