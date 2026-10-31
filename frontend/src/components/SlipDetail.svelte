<script lang="ts">
  import { dragLabel } from "../lib/drag";
  import { onDestroy } from "svelte";
  import { money, signed, label } from "../lib/types";
  import type { RecordGroup, Bet, api as Api } from "../lib/types";
  import { createRequestScope } from "../lib/requests";
  import Modal from "./Modal.svelte";
  let {
    record,
    canCancel,
    layoffsEnabled = false,
    api: accountApi,
    onclose,
    onshow,
    onchanged,
  }: {
    record: RecordGroup;
    canCancel: boolean;
    layoffsEnabled?: boolean;
    api: typeof Api;
    onclose: () => void;
    onshow: (bet: Bet) => Promise<void>;
    onchanged: () => Promise<void>;
  } = $props();
  const requests = createRequestScope(
    () => {},
    (path, options) => accountApi(path, options),
  );
  onDestroy(requests.dispose);
  let confirm = $state(false),
    busy = $state(false),
    error = $state("");
  async function cancel() {
    busy = true;
    error = "";
    try {
      await requests.api(`/slips/${record.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({
          versions: record.items.map(({ id, revision }) => ({ id, revision })),
        }),
      });
      confirm = false;
      await onchanged();
    } catch (e) {
      error = e instanceof Error ? e.message : "整单撤销失败";
    } finally {
      busy = false;
    }
  }
</script>

<Modal title="组合单详情" wide dismissible={!busy} {onclose}>
  <p class="modal-description">
    {new Set(record.items.map((item) => item.market ?? "macau")).size > 1
      ? "港澳组合单"
      : record.items[0]?.market === "hk"
        ? "香港组合单"
        : "新澳门组合单"} · 投注人 {record.bettor} · {record.items.length} 个分项
  </p>
  <div class="slip-detail-summary">
    <div><span>未撤销本金</span><strong>{money(record.stake)}</strong></div>
    <div><span>反水</span><strong>{money(record.totals.rebate)}</strong></div>
    <div>
      <span>投注人净输赢（含反水）</span><strong
        >{record.status === "cancelled"
          ? "已作废"
          : signed(
              record.totals.net === null ? null : -record.totals.net,
            )}</strong
      >
    </div>
  </div>
  <div class="slip-detail-items">
    {#each record.items as item, index (item.id)}<article>
        <div>
          <strong
            >{index + 1}. {item.market === "hk" ? "香港" : "新澳门"} · {item
              .rule.name}</strong
          >
          <p>
            {item.drag
              ? dragLabel(item.rule.kind, item.drag)
              : item.package_zodiacs?.length
                ? `包肖 ${item.package_zodiacs.map((v) => label("zodiac", v)).join(" · ")}`
                : item.selections
                    .map((v) => label(item.rule.kind, v))
                    .join(" · ")}
          </p>
          <small
            >{item.unit_count} 条基础注 · {item.drag
              ? dragLabel(item.rule.kind, item.drag)
              : item.package_zodiacs?.length
                ? "每肖"
                : "每注"}
            {money(item.amount)} · {item.status === "cancelled"
              ? "已作废"
              : item.status === "settled"
                ? "已结算"
                : "待开奖"}</small
          >
        </div>
        <div>
          <span
            >反水 {item.status === "cancelled" ? "—" : money(item.rebate)}</span
          ><strong
            >{item.status === "cancelled"
              ? "不计输赢"
              : signed(
                  item.payout === null
                    ? null
                    : item.payout + item.rebate - item.stake,
                )}</strong
          ><button class="text-button" onclick={() => onshow(item)}
            >分项判定与操作</button
          >
        </div>
      </article>{/each}
  </div>
  <p class="field-help">
    有效本金 {money(record.totals.stake)}，和局退本 {money(
      record.totals.refunded,
    )}
  </p>
  <div class="modal-actions">
    {#if canCancel && record.status !== "cancelled"}<button
        class="button danger"
        disabled={busy}
        onclick={() => {
          confirm = true;
          error = "";
        }}>撤销整张组合单</button
      >{/if}<button class="button secondary" disabled={busy} onclick={onclose}
      >关闭</button
    >
  </div>
</Modal>
{#if confirm}<Modal
    title="确认撤销组合单"
    dismissible={!busy}
    onclose={() => (confirm = false)}
  >
    <p class="modal-description">
      整单所有未撤销分项将作废，不计有效投注及反水，保留审计记录。{#if layoffsEnabled}有尚未撤销的飞出时整单不会被撤销。{/if}
    </p>
    {#if error}<p class="form-error" role="alert">{error}</p>{/if}
    <div class="modal-actions">
      <button
        class="button secondary"
        disabled={busy}
        onclick={() => (confirm = false)}>返回</button
      ><button class="button danger" disabled={busy} onclick={cancel}
        >确认整单撤销</button
      >
    </div>
  </Modal>{/if}
