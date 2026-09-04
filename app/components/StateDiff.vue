<script setup lang="ts">
import type { DiffLine } from '~/utils/diff'

const props = defineProps<{ lines: DiffLine[] }>()
const showUnchanged = ref(false)
const showAll = ref(false)

/**
 * A real state file flattens to thousands of leaf paths, so showing unchanged
 * lines can mean five figures of table rows. Rendering is capped rather than
 * virtualised: a cap needs no dependency, and a diff nobody reads past the
 * first screen of does not earn a windowing library.
 */
const ROW_CAP = 500

const selected = computed(() =>
  showUnchanged.value ? props.lines : props.lines.filter((l) => l.kind !== 'same')
)
const visible = computed(() =>
  showAll.value ? selected.value : selected.value.slice(0, ROW_CAP)
)
const hiddenCount = computed(() => selected.value.length - visible.value.length)
const changeCount = computed(() => props.lines.filter((l) => l.kind !== 'same').length)
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="text-sm text-muted tabular" aria-live="polite">
        {{ changeCount }} {{ changeCount === 1 ? 'change' : 'changes' }}
      </p>
      <USwitch v-model="showUnchanged" label="Show Unchanged Lines" />
    </div>

    <div
      v-if="visible.length === 0"
      class="rounded-lg border border-dashed border-default px-6 py-12 text-center text-sm text-muted text-pretty"
    >
      These Two Versions Are Identical
    </div>

    <!--
      The table scrolls inside this box, never the page. The box is focusable
      and labelled so the scroll is reachable from the keyboard as well as by
      pointer, which a bare overflow container is not.
    -->
    <div
      v-else
      role="region"
      aria-label="State Differences"
      tabindex="0"
      class="overflow-x-auto rounded-lg border border-default [overscroll-behavior-x:contain] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <table class="w-full min-w-[36rem] text-left font-mono text-xs" translate="no">
        <caption class="sr-only">
          Differences between the two selected state versions
        </caption>
        <thead class="sr-only">
          <tr>
            <th scope="col">Change</th>
            <th scope="col">Path</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(line, index) in visible"
            :key="`${line.path}-${line.kind}-${index}`"
            :class="{
              'bg-success/10': line.kind === 'add',
              'bg-error/10': line.kind === 'remove'
            }"
          >
            <!--
              The marker is hidden from assistive technology, but the cell is
              not: dropping a whole <td> would leave the row one column short
              of the three the header declares.
            -->
            <td class="w-6 px-2 py-1 text-center text-muted select-none">
              <span aria-hidden="true">
                {{ line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' ' }}
              </span>
            </td>
            <td class="px-2 py-1">
              <span class="sr-only">
                {{ line.kind === 'add' ? 'Added' : line.kind === 'remove' ? 'Removed' : 'Unchanged' }}:
              </span>
              <span class="break-words">{{ line.path }}</span>
            </td>
            <td class="min-w-0 px-2 py-1 break-words text-muted">{{ line.value }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="hiddenCount > 0" class="flex flex-wrap items-center gap-3">
      <p class="text-sm text-muted tabular">
        Showing the first {{ ROW_CAP }} lines. {{ hiddenCount }} more are not rendered.
      </p>
      <UButton
        color="neutral"
        variant="outline"
        size="xs"
        :label="`Show All ${selected.length} Lines`"
        @click="showAll = true"
      />
    </div>
  </div>
</template>
