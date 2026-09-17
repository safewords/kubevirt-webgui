import { createRouter, createWebHistory } from 'vue-router'
import { useSession } from '@/stores/session'
import { gateway } from '@/api/gateway'

const Empty = { render: () => null }

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue'), meta: { public: true } },
    { path: '/console/:namespace/:name', name: 'console', component: () => import('@/views/ConsoleView.vue') },
    {
      path: '/',
      component: () => import('@/views/MainView.vue'),
      children: [
        { path: '', redirect: { name: 'datacenter' } },
        // Proxmox-style addresses: the datacenter, a cluster-scoped object, a namespaced one.
        { path: 'dc/:panel?', name: 'datacenter', component: Empty },
        { path: 'c/:kind/:name/:panel?', name: 'cluster', component: Empty },
        { path: 'n/:kind/:namespace/:name/:panel?', name: 'namespaced', component: Empty },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
})

router.beforeEach(async (to) => {
  const session = useSession()
  if (session.status === 'starting') {
    gateway.connect()
    // Never hold the first render hostage to the socket: after a few seconds
    // show the login screen, which reports the connection state itself.
    await Promise.race([gateway.whenHello(), new Promise((resolve) => setTimeout(resolve, 5000))])
  }
  if (!to.meta.public && session.status !== 'authenticated') {
    return { name: 'login', query: to.fullPath !== '/' && to.fullPath !== '/dc' ? { next: to.fullPath } : {} }
  }
  if (to.name === 'login' && session.status === 'authenticated') return { path: '/' }
})
