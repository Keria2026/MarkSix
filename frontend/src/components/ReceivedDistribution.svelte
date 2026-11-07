<script lang="ts">
  import { tick } from "svelte";
  import { money, zodiacs, wave } from "../lib/types";
  import type { api as Api, Market } from "../lib/types";
  import { receivedSummary } from "../lib/received";
  import {
    readReceivedDisplay,
    type ReceivedDisplay,
  } from "../lib/received-display";
  import ReceivedDeduction from "./ReceivedDeduction.svelte";
  import type { ReceivedKind } from "../lib/received";
  let {
    api,
    period,
    revision,
    readonly = false,
  }: {
    api: typeof Api;
    period: string;
    revision: unknown;
    readonly?: boolean;
  } = $props();
  const categories: { kind: ReceivedKind; title: string }[] = [
    { kind: "special", title: "特码" },
    { kind: "zodiac", title: "一肖中" },
    { kind: "tail", title: "尾中" },
  ];
  let selected = $state<ReceivedKind>("special");
  let market = $state<Market>("macau");
  let layout = $state<"list" | "grid">("list");
  let data = $state<ReceivedDisplay | null>(null);
  let editor = $state<{
    period: string;
    market: Market;
    kind: ReceivedKind;
    title: string;
    snapshot: ReceivedDisplay;
    restore: boolean;
  } | null>(null);
  let saved = $state("");
  let loadedPeriod = $state("");
  let loadedMarket = $state<Market | null>(null);
  let busy = $state(false);
  let error = $state("");
  let retry = $state(0);
  let editorTrigger: HTMLElement | null = null;
  let focusAfterLoad: HTMLElement | null = null;
  const current = $derived(
    loadedPeriod === period && loadedMarket === market ? data : null,
  );
  const summary = $derived(
    current ? receivedSummary(current.display[selected]) : null,
  );
  const deducted = $derived(
    current ? receivedSummary(current.deducted[selected]).total : 0n,
  );
  const title = $derived(categories.find((c) => c.kind === selected)!.title);
  $effect(() => {
    const id = period;
    const requestedMarket = market;
    revision;
    retry;
    const controller = new AbortController();
    busy = true;
    error = "";
    void api<unknown>(
      `/periods/${id}/received-display?market=${requestedMarket}`,
      {
        signal: controller.signal,
      },
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        data = readReceivedDisplay(value);
        loadedPeriod = id;
        loadedMarket = requestedMarket;
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          error = e instanceof Error ? e.message : "受注分布加载失败，请重试";
      })
      .finally(async () => {
        if (controller.signal.aborted) return;
        busy = false;
        const trigger = focusAfterLoad;
        focusAfterLoad = null;
        if (trigger) {
          await tick();
          if (
            trigger.isConnected &&
            (document.activeElement === document.body ||
              document.activeElement === trigger)
          ) {
            const target = trigger.matches(":disabled")
              ? trigger
                  .closest(".received-controls")
                  ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
              : trigger;
            target?.focus({ preventScroll: true });
          }
        }
      });
    return () => controller.abort();
  });
  $effect(() => {
    if (editor && (editor.period !== period || editor.market !== market))
      editor = null;
  });
  $effect(() => {
    market;
    selected;
    saved = "";
  });
  function open(restore = false) {
    if (current && !busy && !readonly) {
      editorTrigger =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      saved = "";
      editor = {
        period,
        market,
        kind: selected,
        title,
        snapshot: current,
        restore,
      };
    }
  }
  function complete() {
    const restore = editor?.restore;
    editor = null;
    saved = restore ? "已恢复原受注显示" : "已减出，仅调整首页显示";
    focusAfterLoad = editorTrigger;
    retry++;
  }
  function move(event: KeyboardEvent, index: number) {
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % 3
        : event.key === "ArrowLeft"
          ? (index + 2) % 3
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? 2
              : -1;
    if (next < 0) return;
    event.preventDefault();
    selected = categories[next].kind;
    (event.currentTarget as HTMLElement).parentElement
      ?.querySelectorAll<HTMLButtonElement>("button")
      [next]?.focus();
  }
</script>

<section class="glass received-panel" aria-label="受注金额分布">
  <div class="received-heading">
    <div>
      <h2>受注金额分布</h2>
      <p>
        全部投注人 · {market === "hk" ? "香港" : "新澳门"} · {deducted > 0n
          ? "已扣除首页减出"
          : "原受注本金"}
      </p>
    </div>
    <div class="received-controls">
      {#if !readonly}<button
          class="button secondary"
          disabled={busy || !summary || summary.total === 0n || !!error}
          onclick={() => open()}>减出</button
        >
        <button
          class="button secondary"
          disabled={busy || deducted === 0n || !!error}
          onclick={() => open(true)}>恢复显示</button
        >{/if}
      <div
        class="segmented received-market"
        role="group"
        aria-label="受注统计市场"
      >
        <button
          class:active={market === "macau"}
          aria-pressed={market === "macau"}
          onclick={() => (market = "macau")}>新澳门</button
        >
        <button
          class:active={market === "hk"}
          aria-pressed={market === "hk"}
          onclick={() => (market = "hk")}>香港</button
        >
      </div>
      <div
        class="segmented received-switch"
        role="tablist"
        aria-label="受注统计板块"
      >
        {#each categories as category, index}<button
            id={`received-tab-${category.kind}`}
            role="tab"
            aria-controls="received-content"
            aria-selected={selected === category.kind}
            tabindex={selected === category.kind ? 0 : -1}
            class:active={selected === category.kind}
            onclick={() => (selected = category.kind)}
            onkeydown={(event) => move(event, index)}>{category.title}</button
          >{/each}
      </div>
      <div
        class="segmented received-layout"
        role="group"
        aria-label="受注展示方式"
      >
        <button
          class:active={layout === "list"}
          aria-pressed={layout === "list"}
          onclick={() => (layout = "list")}>单行展示</button
        >
        <button
          class:active={layout === "grid"}
          aria-pressed={layout === "grid"}
          onclick={() => (layout = "grid")}>三列网格</button
        >
      </div>
    </div>
  </div>
  <div
    id="received-content"
    role="tabpanel"
    aria-labelledby={`received-tab-${selected}`}
    aria-busy={busy}
  >
    {#if error}<div class="notice" role="alert">
        <span>{error}</span><button
          class="button secondary"
          onclick={() => retry++}>重试</button
        >
      </div>
    {:else if summary}
      {#if saved}<p class="received-note" role="status">{saved}</p>{/if}
      <div class="received-summary">
        <div>
          <span>{title}{deducted > 0n ? "显示总额" : "受注总额"}</span><strong
            >{money(summary.total)}</strong
          >
        </div>
        <div>
          <span>平均每项</span><strong>{money(summary.average)}</strong>
        </div>
        <div>
          <span>高于平均</span><strong
            >{summary.cells.filter((cell) => cell.above).length}<small>
              项</small
            ></strong
          >
        </div>
      </div>
      {#if deducted > 0n}<p class="received-note">
          本板块累计减出 {money(deducted)}，仅影响首页展示。
        </p>{/if}
      <p class="received-note">
        平均按全部 {summary.cells.length} 项计算，包含未受注项。{busy
          ? "正在更新…"
          : summary.total === 0n
            ? deducted > 0n
              ? "本板块显示金额已全部减出。"
              : "本日暂无该类受注。"
            : "高于平均的项目已标记。"}
      </p>
      <div
        class="received-grid"
        class:received-list={layout === "list"}
        role="list"
        aria-label={`${title}逐项受注金额`}
      >
        {#each summary.cells as cell, index}
          {@const name =
            selected === "special"
              ? String(index + 1).padStart(2, "0")
              : selected === "zodiac"
                ? zodiacs[index]
                : `${index}尾`}
          <div class="received-cell" class:above={cell.above} role="listitem">
            <div class="received-item-head">
              <span
                class="received-label"
                data-wave={selected === "special" ? wave(index + 1) : undefined}
                >{name}</span
              >{#if cell.above && layout === "grid"}<span class="received-above"
                  >高于平均</span
                >{/if}
            </div>
            <strong>{money(cell.amount)}</strong>
            {#if cell.above}<small
                >{cell.excess === 0n
                  ? "超出不足 ¥ 0.01"
                  : `超出 ${money(cell.excess)}`}</small
              >{:else}<small
                >{cell.amount === 0
                  ? current?.deducted[selected][index]
                    ? "已减出"
                    : "未受注"
                  : "平均以内"}</small
              >{/if}
          </div>
        {/each}
      </div>
    {:else}<p class="empty-note" role="status">正在加载受注分布…</p>{/if}
  </div>
</section>

{#if editor}
  <ReceivedDeduction
    {api}
    period={editor.period}
    market={editor.market}
    kind={editor.kind}
    title={editor.title}
    snapshot={editor.snapshot}
    restore={editor.restore}
    onclose={() => {
      editor = null;
      focusAfterLoad = editorTrigger;
      retry++;
    }}
    onsuccess={complete}
  />
{/if}

<style>
  .received-panel {
    padding: 24px;
    margin-top: 24px;
  }
  .received-heading {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 20px;
    flex-wrap: wrap;
    margin-bottom: 24px;
  }
  h2 {
    margin: 0;
    font-size: 18px;
  }
  p {
    margin: 8px 0 0;
    color: var(--muted);
    font-size: 13px;
  }
  .received-controls {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
  }
  .received-market button,
  .received-layout button {
    min-width: 88px;
    min-height: 44px;
  }
  .received-switch button {
    min-width: 88px;
    min-height: 44px;
  }
  .received-summary {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;
    padding-bottom: 18px;
    border-bottom: 1px solid var(--line);
  }
  .received-summary span {
    display: block;
    color: var(--muted);
    font-size: 13px;
    margin-bottom: 10px;
  }
  .received-summary strong {
    font-size: 24px;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }
  .received-summary small {
    font-size: 13px;
    font-weight: 400;
  }
  .received-note {
    margin: 16px 0;
  }
  .received-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    border-top: 1px solid var(--line);
    border-left: 1px solid var(--line);
    border-radius: 10px;
    overflow: hidden;
  }
  .received-cell {
    padding: 12px;
    min-width: 0;
    border-right: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
    background: var(--surface, #fff);
  }
  .received-cell.above {
    background: #fff8eb;
  }
  .received-item-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    flex-wrap: wrap;
    min-height: 22px;
  }
  .received-label {
    font-weight: 700;
    font-size: 16px;
  }
  .received-label[data-wave="0"] {
    color: #b6243f;
  }
  .received-label[data-wave="1"] {
    color: #2457c5;
  }
  .received-label[data-wave="2"] {
    color: #08764f;
  }
  .received-above {
    font-size: 12px;
    color: #8c5200;
  }
  .received-cell strong {
    display: block;
    font-variant-numeric: tabular-nums;
    font-size: 18px;
    line-height: 1.35;
    margin: 4px 0 2px;
    overflow-wrap: anywhere;
  }
  .received-cell small {
    display: block;
    line-height: 1.4;
    font-size: 12px;
    color: var(--muted);
  }
  .received-cell.above small {
    color: #8c5200;
  }
  .received-grid.received-list {
    grid-template-columns: minmax(0, 1fr);
  }
  .received-list .received-cell {
    display: grid;
    grid-template-columns: minmax(48px, 1fr) minmax(0, 1.1fr) minmax(80px, 1fr);
    align-items: center;
    gap: 12px;
  }
  .received-list .received-cell strong {
    margin: 0;
    text-align: right;
  }
  .received-list .received-cell small {
    text-align: right;
    overflow-wrap: anywhere;
  }
  @media (max-width: 720px) {
    .received-panel {
      padding: 16px;
    }
    .received-heading {
      gap: 16px;
    }
    .received-controls,
    .received-layout,
    .received-market {
      width: 100%;
    }
    .received-layout,
    .received-market {
      display: flex;
    }
    .received-layout button,
    .received-market button {
      flex: 1;
      min-width: 0;
    }
    .received-list .received-cell {
      grid-template-columns: minmax(40px, 0.75fr) minmax(0, 1fr) minmax(
          72px,
          1fr
        );
      gap: 8px;
    }
    .received-switch {
      width: 100%;
      display: flex;
    }
    .received-switch button {
      flex: 1;
      min-width: 0;
    }
    .received-summary {
      gap: 10px;
    }
    .received-summary strong {
      font-size: 18px;
    }
    .received-cell {
      padding: 12px 8px;
    }
    .received-cell strong {
      font-size: 16px;
    }
    .received-above {
      font-size: 12px;
    }
  }
</style>
