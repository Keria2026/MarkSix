<script lang="ts">
  import { X } from "lucide-svelte";
  import type { Snippet } from "svelte";
  let {
    title,
    onclose,
    children,
    wide = false,
  }: {
    title: string;
    onclose: () => void;
    children: Snippet;
    wide?: boolean;
  } = $props();
  let dialog: HTMLDialogElement;
  $effect(() => {
    dialog?.showModal();
    return () => dialog?.close();
  });
</script>

<dialog
  bind:this={dialog!}
  class="modal glass"
  class:wide
  {onclose}
  aria-label={title}
>
  <div class="modal-header">
    <h2>{title}</h2>
    <button
      type="button"
      class="icon-button"
      aria-label="关闭对话框"
      onclick={() => dialog.close()}><X size={20} /></button
    >
  </div>
  <div class="modal-body">{@render children()}</div>
</dialog>
