<script lang="ts">
  import { onMount } from "svelte";
  let { seconds }: { seconds: number | undefined } = $props();
  let anchor = $state(0);
  let tick = $state(0);
  $effect(() => {
    // performance.now is used only for display; all permissions are enforced by
    // the hosted backend's current authorization and server time.
    void seconds;
    anchor = performance.now();
    tick = anchor;
  });
  onMount(() => {
    const timer = setInterval(() => (tick = performance.now()), 1000);
    return () => clearInterval(timer);
  });
  const remaining = $derived(
    seconds == null
      ? null
      : Math.max(0, seconds - Math.floor(Math.max(0, tick - anchor) / 1000)),
  );
  const duration = $derived(
    remaining == null
      ? "等待授权核验"
      : `${Math.floor(remaining / 86400)} 天 ${String(Math.floor(remaining / 3600) % 24).padStart(2, "0")}:${String(Math.floor(remaining / 60) % 60).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`,
  );
</script>

<span class="license-countdown">{duration}</span>

<style>
  .license-countdown {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
</style>
