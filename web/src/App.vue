<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { faPlugCircleXmark } from '@fortawesome/free-solid-svg-icons'
import DialogHost from '@/components/ui/DialogHost.vue'
import { gateway } from '@/api/gateway'

// Only complain once the socket has had a fair chance to connect.
const grace = ref(true)
onMounted(() => setTimeout(() => (grace.value = false), 4000))
const lost = computed(() => !grace.value && gateway.state.value !== 'open')
</script>

<template>
  <div
    v-if="lost"
    class="fixed top-0 right-0 left-0 z-[70] flex items-center justify-center gap-2 bg-bad px-3 py-1.5 text-[13px] font-medium text-white shadow"
    role="status"
  >
    <Fa :icon="faPlugCircleXmark" />
    <span v-if="gateway.hello.value">Connection to the server lost — reconnecting…</span>
    <span v-else>Cannot reach the server socket at {{ gateway.url() }} — retrying. Check that WebSockets are allowed between this browser and the server.</span>
  </div>
  <RouterView />
  <DialogHost />
</template>
