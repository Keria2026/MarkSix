<script lang="ts">
  import { money, signed, time } from "../lib/types";
  import type { Statistics as Report } from "../lib/types";
  let {
    report,
    category = "all",
    compact = false,
    onbettor,
    onpage,
  }: {
    report: Report;
    category?: "all" | "bettors" | "receivers";
    compact?: boolean;
    onbettor?: (name: string) => void;
    onpage?: (page: number) => void;
  } = $props();
  let page = $state(1);
  const periodId = $derived(report.period);
  const bettorCount = $derived(
    report.bettors.filter((group) => group.totals.units > 0).length,
  );
  const receiverCount = $derived(
    report.receivers.filter((group) => group.totals.units > 0).length,
  );
  const groups = $derived(
    category === "receivers" ? report.receivers : report.bettors,
  );
  const visible = $derived(groups.slice((page - 1) * 20, page * 20));
  $effect(() => {
    periodId;
    category;
    page = 1;
  });
</script>

{#if !compact}
  <div class="stats-grid ledger-stats" aria-label="分类统计摘要">
    {#if category === "receivers"}
      <article class="stat glass">
        <div class="stat-label">飞出本金</div>
        <strong class="stat-value">{money(report.outgoing.stake)}</strong>
        <div class="stat-foot">
          和局退本 {money(report.outgoing.refunded)} · 不计有效本金
        </div>
      </article>
      <article class="stat glass">
        <div class="stat-label">飞出受注方</div>
        <strong class="stat-value">{receiverCount} 人</strong>
        <div class="stat-foot">本期有有效飞出的受注方</div>
      </article>
      <article class="stat glass">
        <div class="stat-label">有效飞出记录</div>
        <strong class="stat-value">{report.outgoing.records} 条</strong>
        <div class="stat-foot">
          {report.outgoing.units} 条有效基础注 · 反水 {money(
            report.outgoing.rebate,
          )}
        </div>
      </article>
      <article class="stat glass">
        <div class="stat-label">本方飞出净盈亏</div>
        <strong
          class="stat-value"
          class:positive={(report.outgoing.net ?? 0) > 0}
          class:negative={(report.outgoing.net ?? 0) < 0}
          >{signed(report.outgoing.net)}</strong
        >
        <div class="stat-foot">飞出返还 ＋ 收到反水 − 飞出本金</div>
      </article>
    {:else if category === "bettors"}
      <article class="stat glass">
        <div class="stat-label">有效投注人数</div>
        <strong class="stat-value">{bettorCount} 人</strong>
        <div class="stat-foot">本期有有效投注的投注人</div>
      </article>
      <article class="stat glass">
        <div class="stat-label">投注人总本金</div>
        <strong class="stat-value">{money(report.incoming.stake)}</strong>
        <div class="stat-foot">
          {report.incoming.records} 条有效记录 · {report.incoming.units} 条基础注
        </div>
      </article>
      <article class="stat glass">
        <div class="stat-label">人均投注本金</div>
        <strong class="stat-value"
          >{money(
            bettorCount ? Math.round(report.incoming.stake / bettorCount) : 0,
          )}</strong
        >
        <div class="stat-foot">有效本金 ÷ 有效投注人数 · 四舍五入到分</div>
      </article>
      <article class="stat glass">
        <div class="stat-label">投注人总净输赢</div>
        <strong
          class="stat-value"
          class:positive={report.incoming.net !== null &&
            report.incoming.net < 0}
          class:negative={report.incoming.net !== null &&
            report.incoming.net > 0}
          >{signed(
            report.incoming.net === null ? null : -report.incoming.net,
          )}</strong
        >
        <div class="stat-foot">投注人视角 · 含本返还 ＋ 反水 − 本金</div>
      </article>
    {:else}
      <article class="stat glass">
        <div class="stat-label">全部受注本金</div>
        <strong class="stat-value">{money(report.incoming.stake)}</strong>
        <div class="stat-foot">
          {report.incoming.units} 条有效基础注 · 和局退本 {money(
            report.incoming.refunded,
          )}
        </div>
      </article>
      <article class="stat glass">
        <div class="stat-label">飞出本金</div>
        <strong class="stat-value">{money(report.outgoing.stake)}</strong>
        <div class="stat-foot">
          {receiverCount} 位受注方 · {report.outgoing.records} 条有效飞出
        </div>
      </article>
      <article class="stat glass">
        <div class="stat-label">自留本金</div>
        <strong class="stat-value">{money(report.retained.stake)}</strong>
        <div class="stat-foot">原受注本金扣除飞出本金</div>
      </article>
      <article class="stat glass">
        <div class="stat-label">自留净盈亏</div>
        <strong
          class="stat-value"
          class:positive={(report.retained.net ?? 0) > 0}
          class:negative={(report.retained.net ?? 0) < 0}
          >{signed(report.retained.net)}</strong
        >
        <div class="stat-foot">原受注净盈亏 ＋ 飞出净盈亏</div>
      </article>
    {/if}
  </div>
{/if}
<section class="glass records-panel">
  <div class="section-head">
    <h2>{category === "receivers" ? "飞出受注方统计" : "投注人分类统计"}</h2>
    <span class="soft-chip">{groups.length} 人</span>
  </div>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable tables need keyboard focus; verified with Axe.) -->
  <div
    class="table-scroll"
    role="region"
    tabindex="0"
    aria-label={category === "receivers"
      ? "飞出受注方统计，可横向滚动"
      : "投注人分类统计，可横向滚动"}
  >
    <table>
      <thead
        ><tr
          ><th>{category === "receivers" ? "受注方" : "投注人"}</th><th
            >有效本金</th
          ><th>反水</th><th>含本返还</th><th
            >{category === "receivers" ? "本方飞出净盈亏" : "投注人净盈亏"}</th
          ><th
            >{category === "receivers" ? "受注方净盈亏" : "本方受注净盈亏"}</th
          ></tr
        ></thead
      ><tbody>
        {#each visible as group}<tr
            ><td
              >{#if onbettor && category !== "receivers"}<button
                  class="text-button"
                  onclick={() => onbettor?.(group.name)}>{group.name}</button
                >{:else}<strong>{group.name}</strong>{/if}</td
            ><td>{money(group.totals.stake)}</td><td
              >{money(group.totals.rebate)}</td
            ><td>{report.settled ? money(group.totals.payout) : "待结算"}</td
            ><td
              >{signed(
                group.totals.net === null
                  ? null
                  : category === "receivers"
                    ? group.totals.net
                    : -group.totals.net,
              )}</td
            ><td
              >{signed(
                group.totals.net === null
                  ? null
                  : category === "receivers"
                    ? -group.totals.net
                    : group.totals.net,
              )}</td
            ></tr
          >{/each}
      </tbody>
    </table>
  </div>
  {#if !groups.length}<div class="empty-state">
      <p>本期暂无{category === "receivers" ? "有效飞出" : "有效受注"}记录。</p>
    </div>{/if}
  {#if groups.length > 20}<div class="table-footer">
      <span>第 {page} / {Math.ceil(groups.length / 20)} 页</span>
      <div class="pagination">
        <button
          class="button secondary"
          disabled={page === 1}
          onclick={() => page--}>上一页</button
        ><button
          class="button secondary"
          disabled={page * 20 >= groups.length}
          onclick={() => page++}>下一页</button
        >
      </div>
    </div>{/if}
</section>
{#if category === "all" && !compact}
  <section class="glass records-panel">
    <div class="section-head">
      <h2>全部账目汇总</h2>
      <span class="muted">本方视角</span>
    </div>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable tables need keyboard focus; verified with Axe.) -->
    <div
      class="table-scroll"
      role="region"
      tabindex="0"
      aria-label="全部账目汇总，可横向滚动"
    >
      <table>
        <thead
          ><tr><th>账目</th><th>有效本金</th><th>反水</th><th>净盈亏</th></tr
          ></thead
        ><tbody
          >{#each [{ name: "原受注", value: report.incoming }, { name: "飞出", value: report.outgoing }, { name: "自留", value: report.retained }] as row}<tr
              ><td>{row.name}</td><td>{money(row.value.stake)}</td><td
                >{money(row.value.rebate)}</td
              ><td>{signed(row.value.net)}</td></tr
            >{/each}</tbody
        >
      </table>
    </div>
  </section>
{/if}
{#if category === "receivers" && !compact}
  <section class="glass records-panel">
    <div class="section-head"><h2>飞出记录</h2></div>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable tables need keyboard focus; verified with Axe.) -->
    <div
      class="table-scroll"
      role="region"
      tabindex="0"
      aria-label="飞出记录，可横向滚动"
    >
      <table>
        <thead
          ><tr
            ><th>受注方 / 时间</th><th>每注飞出</th><th>总额</th><th>状态</th
            ><th>本方飞出盈亏</th></tr
          ></thead
        ><tbody
          >{#each report.layoffs as row}<tr
              ><td
                ><strong>{row.receiver}</strong><small
                  >{time(row.created_at)}</small
                ></td
              ><td>{money(row.amount)}</td><td>{money(row.stake)}</td><td
                >{row.status === "cancelled"
                  ? "已作废"
                  : row.status === "settled"
                    ? "已结算"
                    : "待开奖"}</td
              ><td
                >{row.status === "settled"
                  ? signed((row.payout ?? 0) + row.rebate - row.stake)
                  : "—"}</td
              ></tr
            >{/each}</tbody
        >
      </table>
    </div>
    {#if report.layoffs_total > 20}<div class="table-footer">
        <span
          >{report.layoffs_total} 条飞出记录 · 第 {report.layoffs_page} 页</span
        >
        <div class="pagination">
          <button
            class="button secondary"
            disabled={report.layoffs_page === 1}
            onclick={() => onpage?.(report.layoffs_page - 1)}>上一页</button
          ><button
            class="button secondary"
            disabled={report.layoffs_page * 20 >= report.layoffs_total}
            onclick={() => onpage?.(report.layoffs_page + 1)}>下一页</button
          >
        </div>
      </div>{/if}
  </section>
{/if}
