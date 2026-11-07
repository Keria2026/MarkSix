<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { api as Api } from "../lib/types";
  let {
    api,
    bettors,
    onchanged,
  }: { api: typeof Api; bettors: string[]; onchanged: () => Promise<void> } =
    $props();
  type Item = { bettor: string; ratio: number };
  let items = $state<Item[]>([]),
    name = $state(""),
    percent = $state("100"),
    busy = $state(false),
    error = $state(""),
    message = $state("");
  const controller = new AbortController();
  let loadVersion = 0;
  onDestroy(() => controller.abort());
  async function load() {
    const version = ++loadVersion;
    try {
      const result = (
        await api<{ items: Item[] }>("/settings/bettors", {
          signal: controller.signal,
        })
      ).items;
      if (!controller.signal.aborted && version === loadVersion) {
        items = result;
        error = "";
      }
    } catch (e) {
      if (!controller.signal.aborted && version === loadVersion)
        error = e instanceof Error ? e.message : "加载失败";
    }
  }
  onMount(load);
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    error = "";
    message = "";
    try {
      await api("/settings/bettors", {
        method: "PUT",
        body: JSON.stringify({ bettor: name, percent: String(percent) }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      name = "";
      percent = "100";
      await load();
      await onchanged();
      message = "已保存首页比例";
    } catch (e) {
      if (!controller.signal.aborted)
        error = e instanceof Error ? e.message : "保存失败";
    } finally {
      if (!controller.signal.aborted) busy = false;
    }
  }
  async function remove(item: Item) {
    if (
      busy ||
      !window.confirm(
        `删除“${item.bettor}”的首页比例设置？已有投注按 100% 显示。`,
      )
    )
      return;
    busy = true;
    error = "";
    message = "";
    try {
      await api(`/settings/bettors/${encodeURIComponent(item.bettor)}`, {
        method: "DELETE",
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      await load();
      await onchanged();
      message = "已删除比例设置";
    } catch (e) {
      if (!controller.signal.aborted)
        error = e instanceof Error ? e.message : "删除失败";
    } finally {
      if (!controller.signal.aborted) busy = false;
    }
  }
</script>

<section class="glass bettor-settings" aria-label="投注人首页比例">
  <h2>投注人首页比例</h2>
  <p>
    设置仅影响首页受注金额分布；未设置的投注人按 100%
    计算。修改后立即应用于本业务日已有投注。
  </p>
  <form onsubmit={save}>
    <label
      >投注人<input
        aria-label="投注人名称"
        list="bettor-ratio-names"
        bind:value={name}
        maxlength="80"
        required
        placeholder="输入或选择投注人"
        disabled={busy}
      /></label
    >
    <datalist id="bettor-ratio-names"
      >{#each bettors as bettor}<option value={bettor}
        ></option>{/each}</datalist
    >
    <label
      >首页显示比例（%）<input
        aria-label="首页显示比例（%）"
        type="number"
        min="0"
        max="100"
        step="0.01"
        bind:value={percent}
        required
        disabled={busy}
      /></label
    >
    <button type="submit" class="button primary" disabled={busy}
      >保存投注人</button
    >
  </form>
  {#if error}<p role="alert" class="form-error">{error}</p>
    <button type="button" class="button secondary" onclick={load}
      >重新加载</button
    >{/if}
  {#if message}<p role="status">{message}</p>{/if}
  {#if items.length}<div
      class="bettor-list"
      role="list"
      aria-label="已配置投注人"
    >
      {#each items as item (item.bettor)}<div role="listitem">
          <strong>{item.bettor}</strong><span
            >{(item.ratio / 100).toFixed(2)}%</span
          ><button
            type="button"
            class="button secondary"
            disabled={busy}
            aria-label={`编辑 ${item.bettor}`}
            onclick={() => {
              name = item.bettor;
              percent = String(item.ratio / 100);
              message = "";
            }}>编辑</button
          ><button
            type="button"
            class="button secondary"
            disabled={busy}
            aria-label={`删除 ${item.bettor}`}
            onclick={() => remove(item)}>删除</button
          >
        </div>{/each}
    </div>{:else if !error}<p>暂无单独设置的投注人。</p>{/if}
</section>

<style>
  .bettor-settings {
    padding: 24px;
    margin-top: 20px;
  }
  p {
    color: var(--muted);
    line-height: 1.6;
  }
  form {
    display: flex;
    gap: 12px;
    align-items: end;
    flex-wrap: wrap;
  }
  label {
    flex: 1;
    min-width: 150px;
  }
  input {
    min-height: 44px;
    width: 100%;
    box-sizing: border-box;
  }
  .bettor-list {
    margin-top: 20px;
  }
  .bettor-list > div {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 0;
    border-top: 1px solid var(--line);
  }
  .bettor-list strong {
    flex: 1;
    overflow-wrap: anywhere;
    min-width: 0;
  }
  @media (max-width: 560px) {
    .bettor-settings {
      padding: 16px;
    }
    .bettor-list > div {
      flex-wrap: wrap;
    }
  }
</style>
