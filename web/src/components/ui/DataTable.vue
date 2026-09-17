<script setup lang="ts" generic="T extends Record<string, any>">
import { computed, ref } from 'vue'
import { faSort, faSortDown, faSortUp, faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons'

export interface Column<R = any> {
  key: string
  label: string
  /** Sort / filter / default-cell value. Defaults to `row[key]`. */
  value?: (row: R) => unknown
  width?: string
  align?: 'left' | 'right' | 'center'
  sortable?: boolean
  class?: string
}

const props = withDefaults(
  defineProps<{
    columns: Column<T>[]
    rows: T[]
    rowKey: (row: T) => string
    selected?: string | null
    filterable?: boolean
    filterPlaceholder?: string
    emptyText?: string
    loading?: boolean
    defaultSort?: { key: string; dir: 'asc' | 'desc' }
    /** Constrain height and scroll inside. */
    maxHeight?: string
  }>(),
  { filterable: false, emptyText: 'No items', loading: false },
)
const emit = defineEmits<{ select: [row: T]; activate: [row: T] }>()

const filter = ref('')
const sort = ref(props.defaultSort ?? null)

function cellValue(row: T, column: Column<T>): unknown {
  return column.value ? column.value(row) : row[column.key]
}

const shown = computed(() => {
  let rows = props.rows
  const q = filter.value.trim().toLowerCase()
  if (q) {
    rows = rows.filter((row) => props.columns.some((c) => String(cellValue(row, c) ?? '').toLowerCase().includes(q)))
  }
  if (sort.value) {
    const column = props.columns.find((c) => c.key === sort.value!.key)
    if (column) {
      const dir = sort.value.dir === 'asc' ? 1 : -1
      rows = [...rows].sort((a, b) => {
        const av = cellValue(a, column)
        const bv = cellValue(b, column)
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
        return String(av ?? '').localeCompare(String(bv ?? ''), undefined, { numeric: true }) * dir
      })
    }
  }
  return rows
})

function toggleSort(column: Column<T>) {
  if (column.sortable === false) return
  if (sort.value?.key !== column.key) sort.value = { key: column.key, dir: 'asc' }
  else if (sort.value.dir === 'asc') sort.value = { key: column.key, dir: 'desc' }
  else sort.value = null
}
</script>

<template>
  <div class="flex min-h-0 flex-col">
    <div v-if="filterable || $slots.toolbar" class="flex flex-wrap items-center gap-2 pb-2">
      <slot name="toolbar" />
      <div v-if="filterable" class="relative ml-auto w-56">
        <Fa :icon="faMagnifyingGlass" class="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-xs text-fg-subtle" />
        <input v-model="filter" class="input pl-7" :placeholder="filterPlaceholder ?? 'Filter'" />
      </div>
    </div>
    <div class="min-h-0 overflow-auto rounded-md border border-line bg-surface-1" :style="maxHeight ? { maxHeight } : {}">
      <table class="table-dense">
        <thead>
          <tr>
            <th
              v-for="column in columns"
              :key="column.key"
              :style="column.width ? { width: column.width } : {}"
              :class="[column.align === 'right' ? 'text-right' : column.align === 'center' ? 'text-center' : '', column.sortable !== false ? 'cursor-pointer select-none hover:text-fg' : '']"
              @click="toggleSort(column)"
            >
              {{ column.label }}
              <Fa
                v-if="column.sortable !== false"
                :icon="sort?.key === column.key ? (sort.dir === 'asc' ? faSortUp : faSortDown) : faSort"
                class="ml-1 text-[10px]"
                :class="sort?.key === column.key ? 'text-accent' : 'opacity-30'"
              />
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in shown"
            :key="rowKey(row)"
            :class="{ selected: selected === rowKey(row), 'cursor-pointer': true }"
            @click="emit('select', row)"
            @dblclick="emit('activate', row)"
          >
            <td
              v-for="column in columns"
              :key="column.key"
              :class="[column.class, column.align === 'right' ? 'text-right tabular-nums' : column.align === 'center' ? 'text-center' : '']"
            >
              <slot :name="`cell-${column.key}`" :row="row" :value="cellValue(row, column)">{{ cellValue(row, column) ?? '—' }}</slot>
            </td>
          </tr>
          <tr v-if="!shown.length">
            <td :colspan="columns.length" class="h-16 text-center text-fg-subtle">
              {{ loading ? 'Loading…' : filter ? 'Nothing matches the filter' : emptyText }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
