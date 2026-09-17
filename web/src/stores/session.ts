import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { gateway, type Hello } from '@/api/gateway'
import type { UserInfo } from '@/api/types'

const TICKET_KEY = 'kve.ticket'

interface StoredTicket {
  ticket: string
  expires: number
}

function readTicket(): StoredTicket | null {
  try {
    const raw = localStorage.getItem(TICKET_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredTicket
    if (!parsed.ticket || parsed.expires * 1000 < Date.now()) return null
    return parsed
  } catch {
    return null
  }
}

function writeTicket(ticket: StoredTicket | null) {
  try {
    if (ticket) localStorage.setItem(TICKET_KEY, JSON.stringify(ticket))
    else localStorage.removeItem(TICKET_KEY)
  } catch {
    /* storage unavailable: the session lasts as long as the tab */
  }
}

export const useSession = defineStore('session', () => {
  const status = ref<'starting' | 'anonymous' | 'authenticated'>('starting')
  const user = ref<UserInfo | null>(null)
  const expires = ref<number>(0)
  const hello = computed<Hello | null>(() => gateway.hello.value)
  const lastError = ref<string | null>(null)
  let memoryTicket: StoredTicket | null = null
  let renewTimer: ReturnType<typeof setInterval> | null = null

  function remember(ticket: string, expiresAt: number) {
    memoryTicket = { ticket, expires: expiresAt }
    writeTicket(memoryTicket)
  }

  function adopt(result: { user: UserInfo; expires: number; ticket?: string }) {
    user.value = result.user
    expires.value = result.expires
    if (result.ticket) remember(result.ticket, result.expires)
    status.value = 'authenticated'
    scheduleRenew()
  }

  function scheduleRenew() {
    if (renewTimer) clearInterval(renewTimer)
    // Renew well before expiry, which also re-checks the token is still valid.
    renewTimer = setInterval(async () => {
      if (status.value !== 'authenticated') return
      const remaining = expires.value * 1000 - Date.now()
      if (remaining > 60 * 60 * 1000) return
      try {
        adopt(await gateway.call('auth.renew'))
      } catch {
        /* leave it to expire; the server will say so */
      }
    }, 5 * 60 * 1000)
  }

  /** Called by the gateway after every (re)connection. */
  async function resume() {
    const stored = memoryTicket ?? readTicket()
    if (!stored) {
      if (status.value !== 'anonymous') status.value = 'anonymous'
      return
    }
    try {
      const result = await gateway.call('auth.resume', { ticket: stored.ticket }, { immediate: true, timeout: 15000 })
      memoryTicket = stored
      adopt(result)
    } catch (e: any) {
      if (e?.code === 'Disconnected' || e?.code === 'Timeout') return
      memoryTicket = null
      writeTicket(null)
      user.value = null
      status.value = 'anonymous'
    }
  }

  async function login(token: string) {
    lastError.value = null
    const result = await gateway.call('auth.login', { token })
    adopt(result)
  }

  async function loginAsServer() {
    lastError.value = null
    const result = await gateway.call('auth.login', { method: 'server' })
    adopt(result)
  }

  async function logout() {
    try {
      await gateway.call('auth.logout', {}, { timeout: 5000 })
    } catch {
      /* signing out locally is what matters */
    }
    gateway.closeAllSubscriptions()
    memoryTicket = null
    writeTicket(null)
    user.value = null
    status.value = 'anonymous'
    if (renewTimer) clearInterval(renewTimer)
  }

  function expired() {
    memoryTicket = null
    writeTicket(null)
    user.value = null
    lastError.value = 'Your session has expired. Please sign in again.'
    status.value = 'anonymous'
  }

  const displayName = computed(() => {
    const name = user.value?.username ?? ''
    const sa = name.match(/^system:serviceaccount:([^:]+):(.+)$/)
    return sa ? `${sa[2]}@${sa[1]}` : name
  })

  return { status, user, expires, hello, lastError, displayName, resume, login, loginAsServer, logout, expired }
})
