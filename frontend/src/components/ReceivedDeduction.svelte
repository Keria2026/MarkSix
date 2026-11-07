<script lang="ts">
  import { onDestroy } from "svelte";
  import Modal from "./Modal.svelte";
  import {
    money,
    marketName,
    type api as Api,
    type Market,
  } from "../lib/types";
  import type { ReceivedKind } from "../lib/received";
  import {
    displayCents,
    displayAmount,
    receivedItemName,
    type ReceivedDisplay,
  } from "../lib/received-display";
  let {
    api,
    period,
    market,
    kind,
    title,
    snapshot,
    restore = false,
    onclose,
    onsuccess,
  }: {
    api: typeof Api;
    period: string;
    market: Market;
    kind: ReceivedKind;
    title: string;
    snapshot: ReceivedDisplay;
    restore?: boolean;
    onclose: () => void;
    onsuccess: () => void;
  } = $props();
  let selected = $state<number[]>([]);
  let amount = $state("");
  let busy = $state(false);
  let error = $state("");
  let pending: { signature: string; body: string } | null = null;
  const controller = new AbortController();
  onDestroy(() => controller.abort());
  const cents = $derived(displayCents(amount));
  const eligible = $derived(
    snapshot.display[kind].flatMap((value, index) =>
      value > 0 ? [index] : [],
    ),
  );
  const minimum = $derived(
    selected.length
      ? selected.reduce(
          (min, index) => Math.min(min, snapshot.display[kind][index]),
          Number.MAX_SAFE_INTEGER,
        )
      : 0,
  );
  const valid = $derived(
    restore ||
      (selected.length > 0 && cents !== null && cents <= BigInt(minimum)),
  );
  function toggle(index: number, checked: boolean) {
    selected = checked
      ? [...selected, index].sort((a, b) => a - b)
      : selected.filter((value) => value !== index);
    error = "";
  }
  async function submit() {
    if (!valid || busy) return;
    const change = restore
      ? { action: "reset" }
      : {
          action: "deduct",
          items: selected.map((index) => ({
            index,
            amount: displayAmount(cents!),
          })),
        };
    const payload = { revision: snapshot.revision, kind, change };
    const signature = JSON.stringify(payload);
    if (!pending || pending.signature !== signature)
      pending = {
        signature,
        body: JSON.stringify({ ...payload, request_id: crypto.randomUUID() }),
      };
    busy = true;
    error = "";
    try {
      await api(`/periods/${period}/received-display?market=${market}`, {
        method: "POST",
        body: pending.body,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) onsuccess();
    } catch (e) {
      if (!controller.signal.aborted)
        error = e instanceof Error ? e.message : "首页减出保存失败，请重试";
    } finally {
      if (!controller.signal.aborted) busy = false;
    }
  }
</script>

<Modal
  title={`${restore ? "恢复显示" : "首页减出"} · ${marketName(market)}${title}`}
  onclose={() => {
    if (!busy) onclose();
  }}
  dismissible={!busy}
  wide={!restore}
>
  <form
    id="received-deduction-form"
    onsubmit={(event) => {
      event.preventDefault();
      void submit();
    }}
  >
    <p class="deduction-note">
      {restore
        ? "恢复当前板块减出前的首页金额。"
        : "只调整首页显示，不修改投注、结算或账单。"}
    </p>
    {#if restore}
      <p>
        将清除{marketName(
          market,
        )}{title}本业务日的累计减出，后续按投注人比例计算首页金额。
      </p>
    {:else}
      <div class="deduction-tools">
        <label
          >每项减出金额（元）<input
            inputmode="decimal"
            placeholder="输入每项金额"
            bind:value={amount}
            disabled={busy}
          /></label
        >
        <div>
          <button
            type="button"
            class="button secondary"
            disabled={busy || !eligible.length}
            onclick={() => {
              selected = [...eligible];
              error = "";
            }}>选择全部有金额项</button
          >
          <button
            type="button"
            class="button secondary"
            disabled={busy || !selected.length}
            onclick={() => {
              selected = [];
              error = "";
            }}>清空选择</button
          >
        </div>
      </div>
      <p class="deduction-note" aria-live="polite">
        已选 {selected.length} 项{#if selected.length}，每项最多 {money(
            minimum,
          )}{/if}。快照后的新录入继续累加。
      </p>
      {#if amount && cents === null}<p class="form-error" role="alert">
          请输入大于零、最多两位小数的金额。
        </p>
      {:else if cents !== null && selected.length && cents > BigInt(minimum)}<p
          class="form-error"
          role="alert"
        >
          部分所选项目金额不足，每项最多可减出 {money(minimum)}。
        </p>{/if}
      <div class="deduction-items" role="group" aria-label="选择首页减出项目">
        {#each snapshot.display[kind] as current, index}
          <label class:selected={selected.includes(index)}>
            <input
              type="checkbox"
              checked={selected.includes(index)}
              disabled={busy || current === 0}
              onchange={(event) => toggle(index, event.currentTarget.checked)}
              aria-label={`减出${receivedItemName(kind, index)}`}
            />
            <span>{receivedItemName(kind, index)}</span>
            <strong>{money(current)}</strong>
            {#if selected.includes(index) && cents !== null && cents <= BigInt(current)}<small
                >减后 {money(BigInt(current) - cents)}</small
              >{/if}
          </label>
        {/each}
      </div>
    {/if}
    {#if error}<p class="form-error" role="alert">{error}</p>{/if}
  </form>
  {#snippet footer()}
    {#if error}<button
        type="button"
        class="button secondary"
        disabled={busy}
        onclick={onclose}>刷新后重新选择</button
      >{/if}
    <button
      type="button"
      class="button secondary"
      disabled={busy}
      onclick={onclose}>取消</button
    >
    <button
      type="submit"
      form="received-deduction-form"
      class="button primary"
      disabled={busy || !valid}
      >{busy ? "正在保存…" : restore ? "确认恢复显示" : "确认减出"}</button
    >
  {/snippet}
</Modal>

<style>
  .deduction-note {
    color: var(--muted);
    font-size: 13px;
    line-height: 1.6;
    margin: 0 0 16px;
  }
  .deduction-tools {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }
  .deduction-tools > label {
    display: grid;
    gap: 8px;
    font-size: 14px;
    min-width: 180px;
    flex: 1;
  }
  .deduction-tools > div {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  input:not([type="checkbox"]) {
    width: 100%;
    box-sizing: border-box;
    min-height: 44px;
  }
  .deduction-items {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
  .deduction-items label {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    min-height: 64px;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: 10px;
    cursor: pointer;
    min-width: 0;
  }
  .deduction-items label.selected {
    border-color: var(--brand, #2457c5);
    background: #eef3ff;
  }
  input[type="checkbox"] {
    width: 20px;
    height: 20px;
    flex: none;
  }
  .deduction-items strong {
    margin-left: auto;
    overflow-wrap: anywhere;
    font-size: 14px;
  }
  .deduction-items small {
    width: 100%;
    text-align: right;
    color: var(--muted);
  }
  @media (max-width: 560px) {
    .deduction-items {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .deduction-items label {
      padding: 10px;
    }
    .deduction-tools > label {
      width: 100%;
    }
    .deduction-tools > div {
      width: 100%;
    }
    .deduction-tools button {
      flex: 1;
    }
  }
</style>
