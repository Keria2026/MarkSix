<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { ArrowUp, ArrowDown, ArrowUpToLine } from "lucide-svelte";
  import type { Play, api as Api } from "../lib/types";
  import { createRequestScope } from "../lib/requests";
  import Modal from "./Modal.svelte";
  let {
    plays,
    api: accountApi,
    onclose,
    onsaved,
  }: {
    plays: Play[];
    api: typeof Api;
    onclose: () => void;
    onsaved: () => Promise<void>;
  } = $props();
  const requests = createRequestScope(
    () => {},
    (path, options) => accountApi(path, options),
  );
  onDestroy(requests.dispose);
  let ordered = $state(untrack(() => plays.slice()));
  let busy = $state(false),
    error = $state("");
  function move(index: number, destination: number) {
    const next = [...ordered];
    const [play] = next.splice(index, 1);
    next.splice(destination, 0, play);
    ordered = next;
  }
  async function save() {
    busy = true;
    error = "";
    try {
      await requests.api("/plays/order", {
        method: "PUT",
        body: JSON.stringify({
          plays: ordered.map(({ id, version }) => ({ id, version })),
        }),
      });
      await onsaved();
    } catch (e) {
      error = e instanceof Error ? e.message : "排序保存失败";
    } finally {
      busy = false;
    }
  }
</script>

<Modal title="排序玩法" dismissible={!busy} {onclose}>
  <ol class="play-order-list">
    {#each ordered as play, index (play.id)}<li>
        <span class="order-number">{index + 1}</span>
        <strong
          >{play.rule.name}{#if !play.enabled}<small>已停用</small>{/if}</strong
        >
        <div class="order-controls">
          <button
            class="icon-button"
            aria-label={`将${play.rule.name}置顶`}
            title="置顶"
            disabled={busy || index === 0}
            onclick={() => move(index, 0)}><ArrowUpToLine size={17} /></button
          >
          <button
            class="icon-button"
            aria-label={`上移${play.rule.name}`}
            title="上移"
            disabled={busy || index === 0}
            onclick={() => move(index, index - 1)}><ArrowUp size={17} /></button
          >
          <button
            class="icon-button"
            aria-label={`下移${play.rule.name}`}
            title="下移"
            disabled={busy || index === ordered.length - 1}
            onclick={() => move(index, index + 1)}
            ><ArrowDown size={17} /></button
          >
        </div>
      </li>{/each}
  </ol>
  {#if error}<p class="form-error" role="alert">{error}</p>{/if}
  <div class="modal-actions">
    <button class="button secondary" disabled={busy} onclick={onclose}
      >取消</button
    ><button class="button primary" disabled={busy} onclick={save}
      >{busy ? "保存中…" : "保存排序"}</button
    >
  </div>
</Modal>
