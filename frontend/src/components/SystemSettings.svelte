<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import {
    ArrowRight,
    CalendarDays,
    ChevronDown,
    Clock3,
    ShieldCheck,
  } from "lucide-svelte";
  import Modal from "./Modal.svelte";
  import LicenseCountdown from "./LicenseCountdown.svelte";
  import type { LicenseStatus } from "./Activation.svelte";
  import { annualMapping, wave, zodiacs } from "../lib/types";
  import type { Settings, Mapping, Period, api as Api } from "../lib/types";
  import { createRequestScope } from "../lib/requests";
  let {
    username,
    today,
    licenseStatus,
    api: accountApi,
    notify,
    oncleared,
  }: {
    username: string;
    today: Period;
    licenseStatus: LicenseStatus;
    api: typeof Api;
    notify: (message: string) => void;
    oncleared: () => Promise<void>;
  } = $props();
  const requests = createRequestScope(
    () => {},
    (path, options) => accountApi(path, options),
  );
  const api = requests.api;
  onDestroy(requests.dispose);
  let busy = $state(false),
    loadError = $state("");
  function fail(e: unknown) {
    return e instanceof Error ? e.message : "操作失败，请重试";
  }
  let config = $state<Settings | null>(null),
    closeTime = $state("21:28");
  let mapping = $state<Mapping>({
      zodiac: Array.from({ length: 49 }, (_, i) => (18 - (i % 12)) % 12),
      natal: 6,
    }),
    effectiveDate = $state("");
  let openTime = $state("08:00"),
    settingsUsername = $state(""),
    settingsPassword = $state("");
  let clearHistoryOpen = $state(false);
  let clearHistoryPassword = $state("");
  let clearHistoryConfirmation = $state("");
  let clearHistoryError = $state("");
  let clearHistoryRequest: string | null = null;
  function openClearHistory() {
    clearHistoryRequest = null;
    clearHistoryPassword = "";
    clearHistoryConfirmation = "";
    clearHistoryError = "";
    clearHistoryOpen = true;
  }
  function closeClearHistory() {
    if (busy) return;
    clearHistoryOpen = false;
    clearHistoryRequest = null;
    clearHistoryPassword = "";
    clearHistoryConfirmation = "";
    clearHistoryError = "";
  }
  async function clearHistory(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    clearHistoryError = "";
    clearHistoryRequest ??= crypto.randomUUID();
    try {
      await api("/history/clear", {
        method: "POST",
        body: JSON.stringify({
          password: clearHistoryPassword,
          confirmation: clearHistoryConfirmation,
          request_id: clearHistoryRequest,
        }),
      });
      clearHistoryPassword = "";
      clearHistoryConfirmation = "";
      clearHistoryOpen = false;
      clearHistoryRequest = null;
      await oncleared();
      notify("历史记录已永久清空，本期数据和玩法配置已保留");
    } catch (e) {
      clearHistoryError = fail(e);
    } finally {
      busy = false;
    }
  }
  async function loadSettings() {
    config = await api<Settings>("/settings");
    closeTime = config.closing[0]?.close_time ?? "21:28";
    openTime = config.closing[0]?.open_time ?? "08:00";
    settingsUsername = username;
    settingsPassword = "";
    effectiveDate = config.tomorrow;
    mapping = structuredClone($state.snapshot(today?.mapping ?? mapping));
  }
  async function saveClosing(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    try {
      await api("/settings/closing", {
        method: "PUT",
        body: JSON.stringify({
          open_time: openTime,
          close_time: closeTime,
          username: settingsUsername,
          password: settingsPassword,
        }),
      });
      await loadSettings();
      settingsPassword = "";
      notify("封盘时间已安排，从下一期生效");
    } catch (e) {
      notify(fail(e));
    } finally {
      busy = false;
    }
  }
  async function saveMapping(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    try {
      await api("/settings/mapping", {
        method: "PUT",
        body: JSON.stringify({ effective_date: effectiveDate, mapping }),
      });
      await loadSettings();
      notify("生肖映射已保存，将于指定日期生效");
    } catch (e) {
      notify(fail(e));
    } finally {
      busy = false;
    }
  }
  onMount(() => {
    void loadSettings().catch((e) => (loadError = fail(e)));
  });
</script>

{#if loadError}<p class="inline-error" role="alert">
    {loadError}<button
      class="text-button"
      onclick={() =>
        loadSettings()
          .then(() => (loadError = ""))
          .catch((e) => (loadError = fail(e)))}>重试</button
    >
  </p>{/if}
{#if licenseStatus && !licenseStatus.testing}<section
    class="glass license-summary"
  >
    <h2>
      <ShieldCheck size={18} />{"账号授权"}
    </h2>
    <p>
      {licenseStatus.permanent ? "永久授权" : "有效至"}
      {licenseStatus.permanent
        ? ""
        : licenseStatus.expires_at
          ? new Intl.DateTimeFormat("zh-CN", {
              dateStyle: "medium",
              timeStyle: "short",
              timeZone: "Asia/Shanghai",
            }).format(licenseStatus.expires_at * 1000)
          : "—"}（北京时间）
    </p>
    <p>
      {#if licenseStatus.permanent}永久授权，业务规则照常生效{:else}授权剩余
        <LicenseCountdown seconds={licenseStatus.remaining_seconds} />{/if}
    </p>
    <p class="field-help">
      授权截止日当期可用，到期后使用新激活码续期；已有投注继续结算。
    </p>
  </section>{/if}
<div class="settings-grid">
  <section class="glass closing-panel">
    <div class="section-head">
      <h2><Clock3 size={19} /> 投注时间</h2>
    </div>
    <div class="schedule-rail">
      <span>{today.open_time}<small>开始投注</small></span>
      <div></div>
      <span>{today.close_time}<small>本期封盘</small></span>
      <div></div>
      <span>21:34<small>获取开奖</small></span>
    </div>
    <form onsubmit={saveClosing}>
      <label
        >新的开始时间<input type="time" bind:value={openTime} required /></label
      >
      <label
        >新的封盘时间<input
          type="time"
          bind:value={closeTime}
          required
        /></label
      >
      <p class="field-help">
        从下一期生效，当前期不会重新开放。保存前请验证管理员身份。
      </p>
      <label
        >验证账号<input
          bind:value={settingsUsername}
          autocomplete="username"
          required
          maxlength="80"
        /></label
      >
      <label
        >验证密码<input
          type="password"
          bind:value={settingsPassword}
          autocomplete="current-password"
          required
          maxlength="256"
        /></label
      >
      <button class="button secondary" disabled={busy}
        >保存时间 <ArrowRight size={15} /></button
      >
    </form>
    {#if config}<div class="scheduled-list">
        {#each config.closing.filter((c) => c.effective_date >= today!.business_date) as c}<span
            >{c.effective_date} 生效
            <strong>{c.open_time} – {c.close_time}</strong></span
          >{/each}
      </div>{/if}
  </section>
  <section class="glass mapping-panel">
    <div class="section-head">
      <h2><CalendarDays size={19} /> 生肖映射</h2>
      <span class="soft-chip">本期本命 · {zodiacs[today.mapping.natal]}</span>
    </div>
    <p class="field-help">
      每年 1 月 1 日自动换肖，01、13、25、37、49
      对应当年本命肖；每期映射固定，实际结算以接口为准。
    </p>
    <form onsubmit={saveMapping}>
      <div class="form-two">
        <label
          >生效日期<input
            type="date"
            bind:value={effectiveDate}
            onchange={() =>
              (mapping = annualMapping(Number(effectiveDate.slice(0, 4))))}
            min={config?.tomorrow}
            required
          /></label
        ><label
          >本命生肖<select
            bind:value={mapping.natal}
            onchange={() =>
              (mapping.zodiac = Array.from(
                { length: 49 },
                (_, i) => (mapping.natal - (i % 12) + 12) % 12,
              ))}
            >{#each zodiacs as zodiac, i}<option value={i}>{zodiac}</option
              >{/each}</select
          ></label
        >
      </div>
      <details class="mapping-editor">
        <summary>编辑 49 个号码对应的生肖 <ChevronDown size={15} /></summary>
        <div class="mapping-grid">
          {#each mapping.zodiac as _, i}<label
              ><span class="mini-number" data-wave={wave(i + 1)}
                >{String(i + 1).padStart(2, "0")}</span
              ><select
                aria-label={`${String(i + 1).padStart(2, "0")} 生肖`}
                bind:value={mapping.zodiac[i]}
                >{#each zodiacs as z, index}<option value={index}>{z}</option
                  >{/each}</select
              ></label
            >{/each}
        </div>
      </details>
      <p class="field-help">
        指定日期 00:00 生效，整期固定；实际结算以接口为准。
      </p>
      <button class="button secondary" disabled={busy}
        >安排生效 <ArrowRight size={15} /></button
      >
    </form>
    {#if config}<div class="scheduled-list">
        {#each config.mappings.filter((c) => c.effective_date >= today!.business_date) as c}<span
            >{c.effective_date} 生效
            <strong>本命 {zodiacs[c.mapping.natal]}</strong></span
          >{/each}
      </div>{/if}
  </section>
</div>
<section class="glass history-erasure-panel">
  <div>
    <h2>清空历史记录</h2>
    <p class="field-help">
      永久删除本账号本期之前的投注、飞出、结算和对应操作记录，并删除服务器托管的本账号历史备份。本期数据、玩法配置、账号及授权保留。此操作不可恢复。
    </p>
  </div>
  <button class="button danger" onclick={openClearHistory}
    >清空我的历史记录</button
  >
</section>
{#if clearHistoryOpen}<Modal
    title="永久清空历史记录"
    dismissible={!busy}
    onclose={closeClearHistory}
  >
    <form onsubmit={clearHistory} class="rule-form">
      <p class="inline-error">
        不可恢复：将永久删除本账号本期之前的历史数据及服务器托管备份，无法通过恢复旧备份找回。本期投注与玩法配置保留。
      </p>
      <label
        >当前账号登录密码<input
          type="password"
          bind:value={clearHistoryPassword}
          autocomplete="current-password"
          maxlength="256"
          required
          disabled={busy}
        /></label
      >
      <label
        >输入“永久清空历史记录”确认<input
          bind:value={clearHistoryConfirmation}
          autocomplete="off"
          required
          disabled={busy}
        /></label
      >
      {#if clearHistoryError}<p class="inline-error" role="alert">
          {clearHistoryError}
        </p>{/if}
      <div class="modal-actions">
        <button
          type="button"
          class="button secondary"
          disabled={busy}
          onclick={closeClearHistory}>取消</button
        ><button
          class="button danger"
          disabled={busy || clearHistoryConfirmation !== "永久清空历史记录"}
          >{busy ? "正在永久清空…" : "确认永久清空"}</button
        >
      </div>
    </form>
  </Modal>{/if}
