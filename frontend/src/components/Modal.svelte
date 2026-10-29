<script lang="ts">
  import { X } from "lucide-svelte";
  import type { Snippet } from "svelte";
  import { lockPage, modalMotion } from "../lib/modal";
  let {
    title,
    onclose,
    children,
    footer,
    wide = false,
    dismissible = true,
  }: {
    title: string;
    onclose: () => void;
    children: Snippet;
    footer?: Snippet;
    wide?: boolean;
    dismissible?: boolean;
  } = $props();
  let dialog: HTMLDialogElement;
  $effect(() => {
    const trigger =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialog.showModal();
    const unlock = lockPage(dialog);
    return () => {
      dialog.close();
      unlock();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  });
</script>

<dialog
  bind:this={dialog!}
  class="modal glass"
  class:wide
  in:modalMotion|global
  oncancel={(event) => {
    event.preventDefault();
    if (dismissible) onclose();
  }}
  aria-label={title}
>
  <div class="modal-header">
    <h2>{title}</h2>
    <button
      type="button"
      class="icon-button"
      aria-label="关闭对话框"
      disabled={!dismissible}
      onclick={onclose}><X size={20} /></button
    >
  </div>
  <div class="modal-body">{@render children()}</div>
  {#if footer}<div class="modal-footer">{@render footer()}</div>{/if}
</dialog>
