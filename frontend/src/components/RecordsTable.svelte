<script lang="ts">
  import { dragLabel } from "../lib/drag";
  import {
    ArrowRight,
    ArrowUpRight,
    ChevronLeft,
    ChevronRight,
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
  function loadRecords(page = 1) {
    return onload(page);
  }
</script>

<section class="records-panel glass">
  <div class="section-head">
    <div class="title-with-count">
      <h2>投注记录</h2>
      <span class="count-badge">{records.total}</span>
    </div>
  </div>
  {#if records.items.some((record) => new Set(record.items.map((item) => item.market ?? "macau")).size > 1)}<p
      class="modal-description"
    >
      港澳组合单显示整单金额；本期统计与金额筛选仅计所选市场。
    </p>{/if}
  <form
    class="record-filters"
    onsubmit={(e) => {
      e.preventDefault();
      void loadRecords(1);
    }}
  >
    <label
      >投注总额下限（元）<input
        bind:value={minAmount}
        inputmode="decimal"
        placeholder="不限"
      /></label
    >
    <label
      >投注总额上限（元）<input
        bind:value={maxAmount}
        inputmode="decimal"
        placeholder="不限"
      /></label
    >
    <button class="button secondary" type="submit">筛选</button><button
      class="text-button"
      type="button"
      onclick={() => {
        selectedBettors = [];
        selectedPlays = [];
        recordOrder = "newest";
        minAmount = "";
        maxAmount = "";
        void loadRecords(1);
      }}>重置</button
    >
  </form>
  <div class="record-multifilters">
    <details class="record-picker">
      <summary
        >投注人多选{selectedBettors.length
          ? ` · ${selectedBettors.length} 位`
          : " · 全部"}</summary
      >
      <div class="record-picker-options">
        {#each recordChoices.bettors as name (name)}<label
            class="checkbox-label"
            ><input
              type="checkbox"
              value={name}
              bind:group={selectedBettors}
              onchange={() => queueMicrotask(() => void loadRecords(1))}
            />{name || "未登记"}</label
          >{/each}{#if !recordChoices.bettors.length}<p class="field-help">
            本期暂无投注人
          </p>{/if}
      </div>
    </details>
    <details class="record-picker">
      <summary
        >玩法多选{selectedPlays.length
          ? ` · ${selectedPlays.length} 项`
          : " · 全部"}</summary
      >
      <div class="record-picker-options">
        {#each recordChoices.plays as play (play.id)}<label
            class="checkbox-label"
            ><input
              type="checkbox"
              value={play.id}
              bind:group={selectedPlays}
              onchange={() => queueMicrotask(() => void loadRecords(1))}
            />{play.name}</label
          >{/each}{#if !recordChoices.plays.length}<p class="field-help">
            本期暂无投注玩法
          </p>{/if}
      </div>
    </details>
    <label
      >记录排序<select
        bind:value={recordOrder}
        onchange={() => queueMicrotask(() => void loadRecords(1))}
        ><option value="newest">最新录入优先</option><option value="amount_asc"
          >投注总额从小到大</option
        ><option value="amount_desc">投注总额从大到小</option></select
      ></label
    >
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable tables need keyboard focus; verified with Axe.) -->
  <div
    class="table-scroll"
    role="region"
    tabindex="0"
    aria-label="数据表格，可横向滚动"
  >
    <table>
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
                  : `${bet.items[0].market === "hk" ? "香港" : "新澳门"} · ${bet.items[0].rule.name}`}
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
                      `${bet.grouped ? `${item.market === "hk" ? "香港" : "新澳门"} · ${item.rule.name}：` : ""}${item.drag ? dragLabel(item.rule.kind, item.drag) : item.package_zodiacs?.length ? `包肖 ${item.package_zodiacs.map((v) => label("zodiac", v)).join(" · ")}` : item.selections.map((v) => label(item.rule.kind, v)).join(" · ")}`,
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
    {#if !records.items.length}<div class="empty-state record-empty">
        <p>
          {selectedBettors.length ||
          selectedPlays.length ||
          minAmount ||
          maxAmount
            ? "暂无符合筛选条件的记录，可调整条件或重置筛选。"
            : "本期暂无投注记录"}
        </p>
        {#if !historical && canEnter}<button class="text-button" onclick={onbet}
            >录入第一笔投注 <ArrowRight size={15} /></button
          >{/if}
      </div>{/if}
  </div>
  <div class="table-footer">
    <span>共 {records.total} 条记录</span>
    <div class="pagination">
      <button
        class="icon-button"
        aria-label="上一页记录"
        disabled={records.page === 1}
        onclick={() => loadRecords(records.page - 1)}
        ><ChevronLeft size={16} /></button
      ><span>{records.page}</span><button
        class="icon-button"
        aria-label="下一页记录"
        disabled={records.page * 25 >= records.total}
        onclick={() => loadRecords(records.page + 1)}
        ><ChevronRight size={16} /></button
      >
    </div>
  </div>
</section>
