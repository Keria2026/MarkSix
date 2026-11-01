<script lang="ts">
  import FilterPicker from "./FilterPicker.svelte";
  import { dragLabel } from "../lib/drag";
  import {
    ArrowRight,
    ArrowUpRight,
    ChevronLeft,
    ChevronRight,
    ListFilter,
    SearchX,
    ReceiptText,
  } from "lucide-svelte";
  import { money, signed, label } from "../lib/types";
  import type { Page, RecordGroup } from "../lib/types";
  let {
    records,
    recordChoices,
    historical,
    canEnter = true,
    selectedBettors = $bindable(),
    selectedPlays = $bindable(),
    minAmount = $bindable(),
    maxAmount = $bindable(),
    recordOrder = $bindable(),
    onload,
    showDetail,
    onbet,
  }: {
    records: Page<RecordGroup>;
    recordChoices: { bettors: string[]; plays: { id: number; name: string }[] };
    historical: boolean;
    canEnter?: boolean;
    selectedBettors: string[];
    selectedPlays: number[];
    minAmount: string;
    maxAmount: string;
    recordOrder: string;
    onload: (page?: number) => Promise<void>;
    showDetail: (bet: RecordGroup) => Promise<void>;
    onbet: () => Promise<void>;
  } = $props();
  let pendingBettors = $state<string[]>([]);
  let pendingPlays = $state<number[]>([]);
  let pendingMin = $state("");
  let pendingMax = $state("");
  let pendingOrder = $state("newest");
  let busy = $state(false);
  let error = $state("");
  $effect(() => {
    pendingBettors = [...selectedBettors];
    pendingPlays = [...selectedPlays];
    pendingMin = minAmount;
    pendingMax = maxAmount;
    pendingOrder = recordOrder;
  });
  const filtered = $derived(
    !!(
      selectedBettors.length ||
      selectedPlays.length ||
      minAmount ||
      maxAmount
    ),
  );
  const dirty = $derived(
    JSON.stringify([
      pendingBettors,
      pendingPlays,
      pendingMin,
      pendingMax,
      pendingOrder,
    ]) !==
      JSON.stringify([
        selectedBettors,
        selectedPlays,
        minAmount,
        maxAmount,
        recordOrder,
      ]),
  );
  async function loadRecords(page = 1) {
    if (busy) return;
    busy = true;
    try {
      error = "";
      await onload(page);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError"))
        error =
          cause instanceof Error ? cause.message : "记录加载失败，请重试。";
    } finally {
      busy = false;
    }
  }
  async function applyFilters() {
    error = "";
    const amounts = [pendingMin.trim(), pendingMax.trim()];
    if (amounts.some((value) => value && !/^\d+(?:\.\d{1,2})?$/.test(value))) {
      error = "请输入非负金额，最多保留两位小数。";
      return;
    }
    if (amounts.every(Boolean) && Number(amounts[0]) > Number(amounts[1])) {
      error = "金额下限不能大于上限。";
      return;
    }
    selectedBettors = [...pendingBettors];
    selectedPlays = [...pendingPlays];
    [minAmount, maxAmount] = amounts;
    recordOrder = pendingOrder;
    await loadRecords();
  }
  function resetFilters() {
    selectedBettors = [];
    selectedPlays = [];
    minAmount = maxAmount = "";
    recordOrder = "newest";
    // Also clear unapplied edits when the applied filters were already empty.
    pendingBettors = [];
    pendingPlays = [];
    pendingMin = pendingMax = "";
    pendingOrder = "newest";
    error = "";
    void loadRecords();
  }
</script>

<section class="records-panel glass" aria-busy={busy}>
  <div class="section-head">
    <div class="title-with-count">
      <h2>投注记录</h2>
      <span class="count-badge">{records.total}</span>
    </div>
  </div>
  <form
    class="record-filters"
    onsubmit={(event) => {
      event.preventDefault();
      void applyFilters();
    }}
    aria-label="筛选投注记录"
  >
    <fieldset class="filter-fields" disabled={busy}>
      <legend class="sr-only">筛选条件</legend>
      <FilterPicker
        label="投注人"
        options={recordChoices.bettors.map((name) => ({
          value: name,
          label: name || "未登记",
        }))}
        bind:selected={pendingBettors}
        disabled={busy}
      />
      <FilterPicker
        label="玩法"
        options={recordChoices.plays.map((play) => ({
          value: play.id,
          label: play.name,
        }))}
        bind:selected={pendingPlays}
        disabled={busy}
      />
      <div class="amount-range">
        <span class="filter-label" id="amount-range-label">投注总额（元）</span>
        <div role="group" aria-labelledby="amount-range-label">
          <input
            aria-label="投注总额下限（元）"
            bind:value={pendingMin}
            inputmode="decimal"
            placeholder="最低金额"
          />
          <span aria-hidden="true">—</span>
          <input
            aria-label="投注总额上限（元）"
            bind:value={pendingMax}
            inputmode="decimal"
            placeholder="最高金额"
          />
        </div>
      </div>
      <label class="record-order"
        >记录排序<select aria-label="记录排序" bind:value={pendingOrder}>
          <option value="newest">最新录入优先</option>
          <option value="amount_asc">投注总额从小到大</option>
          <option value="amount_desc">投注总额从大到小</option>
        </select></label
      >
      <div class="filter-actions">
        <button class="button primary" type="submit"
          ><ListFilter size={16} />{busy ? "筛选中…" : "筛选"}</button
        >
        <button
          class="button secondary"
          type="button"
          disabled={!filtered && !dirty && recordOrder === "newest"}
          onclick={resetFilters}>重置</button
        >
      </div>
    </fieldset>
    {#if error}<p class="form-error" role="alert">{error}</p>{/if}
    {#if dirty}<p class="field-help filter-hint" role="status">
        条件已修改，点击“筛选”应用。
      </p>{:else if filtered}<p class="field-help filter-hint" role="status">
        已应用筛选 · 找到 {records.total} 条记录
      </p>{/if}
  </form>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable tables need keyboard focus; verified with Axe.) -->
  <div
    class="table-scroll"
    role="region"
    tabindex="0"
    aria-label="数据表格，可横向滚动"
  >
    <table class="ledger-table">
      <thead
        ><tr
          ><th>玩法 / 投注人 / 投注项</th><th>基础注</th><th>投注本金</th><th
            >反水</th
          ><th>盘口净盈利</th><th>状态</th><th>操作</th></tr
        ></thead
      ><tbody
        >{#each records.items as bet}<tr
            ><td
              ><strong
                >{bet.grouped
                  ? `组合单 · ${bet.items.length} 项`
                  : `${bet.items[0].market === "hk" ? "香港" : "新澳门"} · ${bet.items[0].rule.name}${bet.items[0].expect ? ` · ${bet.items[0].expect}期` : ""}`}
                {#if !bet.grouped && bet.items[0].compound}<span
                    class="table-tag">复式</span
                  >{:else if !bet.grouped && bet.unit_count > 1}<span
                    class="table-tag">多选</span
                  >{/if}
              </strong><small class="bettor-name"
                >{bet.bettor || "未登记（旧记录）"}</small
              >
              <small class="bet-selection"
                >{bet.items
                  .slice(0, 3)
                  .map(
                    (item) =>
                      `${bet.grouped ? `${item.market === "hk" ? "香港" : "新澳门"} · ${item.rule.name}${item.expect ? ` · ${item.expect}期` : ""}：` : ""}${item.drag ? dragLabel(item.rule.kind, item.drag) : item.package_zodiacs?.length ? `包肖 ${item.package_zodiacs.map((v) => label("zodiac", v)).join(" · ")}` : item.selections.map((v) => label(item.rule.kind, v)).join(" · ")}`,
                  )
                  .join("；")}{bet.items.length > 3 ? "…" : ""}</small
              >
            </td><td>{bet.unit_count} 注</td><td>{money(bet.stake)}</td><td
              >{bet.status === "cancelled" ? "—" : money(bet.totals.rebate)}</td
            ><td
              class:positive={(bet.totals.net ?? 0) > 0}
              class:negative={(bet.totals.net ?? 0) < 0}
              ><strong
                >{bet.status === "settled"
                  ? signed(bet.totals.net)
                  : bet.status === "cancelled"
                    ? "—"
                    : "待结算"}</strong
              ></td
            ><td
              ><span class="record-status" data-status={bet.status}
                >{bet.status === "settled"
                  ? "已结算"
                  : bet.status === "cancelled"
                    ? "已撤销"
                    : "待开奖"}</span
              ></td
            ><td
              ><button class="text-button" onclick={() => showDetail(bet)}
                >详情 <ArrowUpRight size={13} /></button
              ></td
            ></tr
          >{/each}</tbody
      >
    </table>
  </div>
  {#if !records.items.length}<div class="empty-state record-empty">
      <div class="empty-icon" aria-hidden="true">
        {#if filtered}<SearchX size={24} />{:else}<ReceiptText size={24} />{/if}
      </div>
      <h3>{filtered ? "没有符合条件的记录" : "本期暂无投注记录"}</h3>
      <p>
        {filtered
          ? "调整投注人、玩法或金额范围后再试。"
          : "录入后，可在这里查看投注明细与结算状态。"}
      </p>
      {#if filtered}<button
          class="button secondary"
          disabled={busy}
          onclick={resetFilters}>清除筛选</button
        >
      {:else if !historical && canEnter}<button
          class="text-button"
          onclick={onbet}>录入第一笔投注 <ArrowRight size={15} /></button
        >{/if}
    </div>{/if}
  <div class="table-footer">
    <span>共 {records.total} 条记录</span>
    <div class="pagination">
      <button
        class="icon-button"
        aria-label="上一页记录"
        disabled={busy || records.page <= 1}
        onclick={() => loadRecords(records.page - 1)}
        ><ChevronLeft size={16} /></button
      ><span>{records.page} / {Math.max(1, Math.ceil(records.total / 25))}</span
      ><button
        class="icon-button"
        aria-label="下一页记录"
        disabled={busy || records.page * 25 >= records.total}
        onclick={() => loadRecords(records.page + 1)}
        ><ChevronRight size={16} /></button
      >
    </div>
  </div>
</section>
