<script setup lang="ts">
import { faFileCode } from '@fortawesome/free-solid-svg-icons'
import Modal from '@/components/ui/Modal.vue'
import ResourceYaml from '@/components/common/ResourceYaml.vue'
import type { KObject } from '@/api/types'

defineProps<{ policy: KObject }>()
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <Modal :title="`NetworkPolicy ${policy.metadata.name}`" :icon="faFileCode" large @close="emit('close')">
    <div class="h-full p-3">
      <ResourceYaml :object="policy" :resource-ref="{ apiVersion: 'networking.k8s.io/v1', resource: 'networkpolicies', namespace: policy.metadata.namespace }" />
    </div>
  </Modal>
</template>
