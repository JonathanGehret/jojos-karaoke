<script lang="ts">
  // Queue with Pointer Events drag-to-reorder for the host (works with touch; no HTML5 drag).
  import { ArrowUpToLine, GripVertical, LoaderCircle, X } from '@lucide/svelte';
  import type { QueueItem } from '$shared/protocol';

  let {
    items, youId = null, admin = false, compact = false,
    onmove, onremove, onplaynext,
  }: {
    items: QueueItem[]; youId?: string | null; admin?: boolean; compact?: boolean;
    onmove?: (id: string, to: number) => void; onremove?: (id: string) => void; onplaynext?: (id: string) => void;
  } = $props();

  let list: HTMLOListElement;
  let dragId = $state<string | null>(null);
  let dragY = $state(0);
  let startY = 0;
  let target = $state(-1);

  function down(e: PointerEvent, id: string) {
    if (!admin) return;
    e.preventDefault();
    dragId = id;
    startY = e.clientY;
    dragY = 0;
    target = items.findIndex((i) => i.id === id);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent) {
    if (!dragId) return;
    dragY = e.clientY - startY;
    const rows = [...list.querySelectorAll<HTMLElement>('li[data-id]')];
    const from = items.findIndex((i) => i.id === dragId);
    let t = from;
    rows.forEach((row, i) => {
      const r = row.getBoundingClientRect();
      const mid = r.top + r.height / 2;
      if (i < from && e.clientY < mid && t > i) t = i;
      if (i > from && e.clientY > mid) t = i;
    });
    target = t;
  }
  function up() {
    if (!dragId) return;
    const from = items.findIndex((i) => i.id === dragId);
    if (target >= 0 && target !== from) onmove?.(dragId, target);
    dragId = null;
    dragY = 0;
  }
</script>

<ol class="queue" class:compact bind:this={list}>
  {#each items as it, i (it.id)}
    <li data-id={it.id} class:mine={it.memberId === youId} class:dragging={dragId === it.id}
        class:drop-before={dragId && target === i && i < items.findIndex((x) => x.id === dragId)}
        class:drop-after={dragId && target === i && i > items.findIndex((x) => x.id === dragId)}
        style:transform={dragId === it.id ? `translateY(${dragY}px)` : undefined}>
      {#if admin && !compact}
        <button class="handle" aria-label="Drag to reorder" onpointerdown={(e) => down(e, it.id)}
                onpointermove={move} onpointerup={up} onpointercancel={up}><GripVertical size={20} /></button>
      {/if}
      <span class="pos">{i + 1}</span>
      <span class="what">
        <span class="title">{it.title}{#if it.artist}<span class="artist"> · {it.artist}</span>{/if}</span>
        <span class="who">{it.nickname}
          {#if it.status === 'processing'}
            <span class="badge proc"><LoaderCircle size={12} class="spin" />making… {Math.round(it.progress?.pct ?? 0)}%{#if it.progress?.etaS} · ~{Math.ceil(it.progress.etaS / 60)} min{/if}{#if it.playable} · can start{/if}</span>
          {:else if it.status === 'failed'}
            <span class="badge fail" title={it.error}>failed</span>
          {/if}
        </span>
      </span>
      {#if !compact && (admin || it.memberId === youId)}
        <span class="acts">
          {#if admin && i > 0}<button class="small icon" onclick={() => onplaynext?.(it.id)} title="Play next" aria-label="Play {it.title} next"><ArrowUpToLine size={16} /></button>{/if}
          <button class="small icon" onclick={() => onremove?.(it.id)} title="Remove" aria-label="Remove {it.title}"><X size={16} /></button>
        </span>
      {/if}
    </li>
  {:else}
    <li class="empty">The queue is empty. Pick a song!</li>
  {/each}
</ol>
