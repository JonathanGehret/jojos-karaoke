<script lang="ts">
  let { message }: { message: string | null } = $props();
</script>

{#if message}
  <div class="toast" role="status">{message}</div>
{/if}
