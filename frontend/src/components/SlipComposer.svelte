<script lang="ts">
  import { onDestroy } from "svelte";
  import { Trash2, Layers3 } from "lucide-svelte";
  import { money, label, entryCents } from "../lib/types";
  import type { SlipDraftLine, Period, api as Api } from "../lib/types";
  import { createRequestScope } from "../lib/requests";
  let {
    items = $bindable(),
    busy = $bindable(),
    pending = $bindable(),
    period,
    bettor,
    today,
    api: accountApi,
    onrecorded,
  }: {
    items: SlipDraftLine[];
    busy: boolean;
    pending: { key: string; id: string } | null;
    period: string;
    bettor: string;
    today: Period;
    api: typeof Api;
    onrecorded: () => Promise<void>;
  } = $props();
  const requests = createRequestScope(
    () => {},
    (path, options) => accountApi(path, options),
  );
  onDestroy(requests.dispose);
  let error = $state("");
  const units = $derived(items.reduce((sum, item) => sum + item.units, 0));
  const valid = $derived(
    period === today.id &&
      items.length > 0 &&
      items.length <= 100 &&
      units <= 1000 &&
      items.every((item) => entryCents(item.amount) !== null),
  );
  const stake = $derived(
    items.reduce(
      (sum, item) =>
        sum +
        (entryCents(item.amount) ?? 0n) *
          BigInt(item.package_zodiacs?.length || item.units),
      0n,
    ),
  );
  async function submit() {
    if (!valid || busy || !bettor.trim() || !today.accepting_entries) return;
    const body = {
      period,
      bettor: bettor.trim(),
      items: items.map(
        ({
          play_id,
          play_version,
          selections,
          compound,
          amount,
          package_zodiacs,
        }) => ({
          play_id,
          play_version,
          selections,
          compound,
          amount,
          ...(package_zodiacs?.length ? { package_zodiacs } : {}),
        }),
      ),
    };
    const key = JSON.stringify(body);
    if (!pending || pending.key !== key)
      pending = { key, id: crypto.randomUUID() };
    busy = true;
    error = "";
    try {
      await requests.api("/slips", {
        method: "POST",
        body: JSON.stringify({ ...body, request_id: pending.id }),
      });
      items = [];
      pending = null;
      await onrecorded();
    } catch (e) {
      error = e instanceof Error ? e.message : "组合单提交失败";
    } finally {
      busy = false;
    }
  }
</script>

{#if items.length}<section class="glass slip-composer" aria-label="组合单草稿">
    <div class="section-head">
      <h2>
        <Layers3 size={19} />组合单
        <span class="count-badge">{items.length} 项</span>
      </h2>
      <span class="soft-chip">{bettor.trim() || "请填写投注人"}</span>
    </div>
    <p class="field-help">
      分项独立判定后相加，不连乘赔率。所有分项一起提交，有一项不合法则整单不保存。
    </p>
    <ol class="slip-draft-list">
      {#each items as item, index (item.key)}<li>
          <div>
            <strong>{index + 1}. {item.rule.name}</strong>
            <p>
              {item.package_zodiacs?.length
                ? `包肖：${item.package_zodiacs.map((v) => label("zodiac", v)).join(" · ")}`
                : item.selections
                    .map((v) => label(item.rule.kind, v))
                    .join(" · ")}
            </p>
            <small
              >{item.units} 注 · V{item.play_version}{item.compound
                ? " · 复式"
                : ""}</small
            >
          </div>
          <label
            >{item.package_zodiacs?.length
              ? "每肖金额（元）"
              : "每注金额（元）"}<input
              aria-label={`组合单第${index + 1}项每注金额`}
              bind:value={item.amount}
              inputmode="decimal"
              maxlength="15"
              disabled={busy}
            /></label
          >
          <button
            class="icon-button"
            aria-label={`移除组合单第${index + 1}项`}
            disabled={busy}
            onclick={() =>
              (items = items.filter((row) => row.key !== item.key))}
            ><Trash2 size={18} /></button
          >
        </li>{/each}
    </ol>
    <div class="slip-total">
      <span>{units} 条基础注 · 整单本金</span><strong>{money(stake)}</strong>
    </div>
    {#if period !== today.id}<p class="form-error" role="alert">
        草稿属于第 {period} 期，当前已换期，请清空后重新录入。
      </p>{/if}
    {#if units > 1000}<p class="form-error" role="alert">
        整单最多 1000 条基础注，请移除部分分项。
      </p>{/if}
    {#if error}<p class="form-error" role="alert">{error}</p>{/if}
    <div class="modal-actions">
      <button
        class="button secondary"
        disabled={busy}
        onclick={() => (items = [])}>清空组合单草稿</button
      ><button
        class="button primary"
        disabled={busy || !valid || !bettor.trim() || !today.accepting_entries}
        onclick={submit}>{busy ? "整单提交中…" : "确认录入组合单"}</button
      >
    </div>
  </section>{/if}
