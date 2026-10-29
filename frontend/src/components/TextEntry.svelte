<script lang="ts">
  import { onMount, onDestroy, untrack, tick } from "svelte";
  import {
    FileText,
    ScanText,
    RotateCcw,
    LoaderCircle,
    Trash2,
    AlertCircle,
  } from "lucide-svelte";
  import Modal from "./Modal.svelte";
  import { specialRatePlay } from "../lib/features";
  import { money, label, entryCents } from "../lib/types";
  import type { Bootstrap, Period, api as Api } from "../lib/types";
  import { createRequestScope } from "../lib/requests";
  import {
    parseText,
    compileRow,
    confirmedPreferences,
    playCandidates,
  } from "../lib/text-entry";
  import type { TextDraft, TextPreference } from "../lib/text-entry";
  let {
    draft = $bindable(),
    boot,
    today,
    api: accountApi,
    onrecorded,
    notify,
  }: {
    draft: TextDraft;
    boot: Bootstrap;
    today: Period;
    api: typeof Api;
    onrecorded: () => Promise<void>;
    notify: (message: string) => void;
  } = $props();
  const requests = createRequestScope(
    () => {},
    (path, options) => accountApi(path, options),
  );
  onDestroy(requests.dispose);
  let preferences = $state<TextPreference[]>([]);
  let preferencesReady = $state(false);
  let busy = $state(false);
  let error = $state("");
  let previewKey = $state("");
  interface Preview {
    valid: boolean;
    units: number;
    stake: number;
    error: string | null;
    items: { units: number; stake: number; error: string | null }[];
  }
  let preview = $state<Preview | null>(null);
  let reviewOpen = $state(false);
  let checking = $state(false);
  let reviewError = $state("");
  let retryCount = $state(0);
  interface BettorRate {
    play_id: number;
    play_version: number;
    amount_mode: TextPreference["amount_mode"];
  }
  let rateChoice = $state(0);
  let rateLoading = $state(false);
  let rateError = $state("");
  let rateFor = $state("");
  let rateLoadedKey = "";
  let parseRevision = $state(0);
  const genericSpecial = new Set(["特码", "特", "澳特", "特码直选"]);
  const rates = $derived(boot.plays.filter(specialRatePlay));
  const rateRows = $derived(
    draft.rows.filter(
      (row) =>
        !row.excluded &&
        (rates.some((play) => play.id === row.playId) ||
          (!row.playId &&
            genericSpecial.has(row.playLabel) &&
            rates.length > 0)),
    ),
  );
  const rateSignature = $derived(rateRows.map((row) => row.key).join("|"));
  const rateVersions = $derived(
    rates.map((play) => `${play.id}:${play.version}`).join("|"),
  );
  function resetRates() {
    for (const row of rateRows) {
      row.playId = row.basePlayId ?? row.playId;
      row.mode = row.baseMode ?? row.mode;
    }
    const ids = new Set(rateRows.map((row) => row.playId));
    rateChoice = ids.size === 1 ? [...ids][0] : 0;
  }
  function chooseRate(id: number) {
    if (!id) {
      resetRates();
      return;
    }
    rateChoice = id;
    for (const row of rateRows) row.playId = id;
  }
  $effect(() => {
    const open = reviewOpen;
    const bettor = draft.bettor.trim();
    const signature = rateSignature;
    const contextKey = `${bettor}\0${parseRevision}\0${rateVersions}`;
    if (open && signature && bettor && rateLoadedKey === contextKey) {
      rateFor = bettor;
      return;
    }
    rateFor = "";
    rateError = "";
    rateLoading = false;
    if (!open || !signature || !bettor) return;
    untrack(resetRates);
    rateLoading = true;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const { preference } = await requests.api<{
          preference: BettorRate | null;
        }>("/text-entry/bettor-preference", {
          method: "POST",
          body: JSON.stringify({ bettor }),
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (
          preference &&
          rates.some(
            (play) =>
              play.id === preference.play_id &&
              play.version === preference.play_version,
          )
        ) {
          // Explicit fee names in the source take precedence over a bettor habit.
          for (const row of rateRows)
            if (genericSpecial.has(row.playLabel)) {
              row.playId = preference.play_id;
              if (!row.marker) row.mode = preference.amount_mode;
            }
          const ids = new Set(rateRows.map((row) => row.playId));
          rateChoice = ids.size === 1 ? [...ids][0] : 0;
        }
        rateLoadedKey = contextKey;
        rateFor = bettor;
      } catch (e) {
        if (!controller.signal.aborted) rateError = fail(e);
      } finally {
        if (!controller.signal.aborted) rateLoading = false;
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  });

  const compiled = $derived(
    draft.rows.map((row) =>
      row.excluded
        ? { items: [], error: "" }
        : compileRow(row, boot.plays, today.mapping),
    ),
  );
  const activeRows = $derived(draft.rows.filter((row) => !row.excluded));
  const items = $derived(compiled.flatMap((row) => row.items));
  let reviewContent = $state<HTMLDivElement>();
  const issues = $derived(
    draft.rows.flatMap((row, index) =>
      !row.excluded && (compiled[index].error || rowQuote(index).error)
        ? [index]
        : [],
    ),
  );
  function focusIssue() {
    reviewContent?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }
  async function removeRow(index: number) {
    draft.rows = draft.rows.filter((_, i) => i !== index);
    await tick();
    reviewContent
      ?.querySelector<HTMLElement>(
        `[data-row-index="${Math.min(index, draft.rows.length - 1)}"] textarea`,
      )
      ?.focus();
  }
  const input = $derived({
    period: today.id,
    bettor: draft.bettor.trim(),
    items,
  });
  // Polling changes to period, mapping, rules, or the draft invalidate approval.
  const key = $derived(
    JSON.stringify({
      input,
      raw: draft.raw,
      recognized: draft.recognized,
      rows: draft.rows,
      mapping: today.mapping,
      plays: boot.plays.map((p) => [p.id, p.version, p.enabled]),
    }),
  );
  const parsed = $derived(
    draft.raw === draft.recognized && draft.rows.length > 0,
  );
  const canPreview = $derived(
    parsed &&
      !rateLoading &&
      !rateError &&
      (!rateRows.length || rateFor === draft.bettor.trim()) &&
      !!draft.bettor.trim() &&
      items.length > 0 &&
      items.length <= 100 &&
      compiled.every((row) => !row.error) &&
      today.accepting_entries,
  );
  const ready = $derived(
    reviewOpen &&
      canPreview &&
      !checking &&
      previewKey === key &&
      preview?.valid === true,
  );
  const aliases = $derived([
    ...new Set(
      draft.rows
        .filter(
          (r) =>
            !r.excluded &&
            !(
              genericSpecial.has(r.playLabel) &&
              rates.some((play) => play.id === r.playId)
            ) &&
            r.playLabel &&
            !r.customAlias &&
            boot.plays.find((p) => p.id === r.playId)?.rule.name !==
              r.playLabel,
        )
        .map((r) => r.playLabel),
    ),
  ]);
  function fail(e: unknown) {
    return e instanceof Error ? e.message : "操作失败，请重试";
  }
  async function loadPreferences() {
    preferencesReady = false;
    try {
      preferences = await requests.api<TextPreference[]>(
        "/text-entry/preferences",
      );
      preferencesReady = true;
    } catch (e) {
      error = fail(e);
    }
  }
  onMount(() => {
    void loadPreferences();
  });
  function checkText() {
    if (busy || !preferencesReady) return;
    error = "";
    try {
      if (!parsed) {
        draft.rows = parseText(draft.raw, boot.plays, preferences);
        parseRevision++;
        draft.recognized = draft.raw;
      }
      if (!draft.rows.length) {
        error = "请粘贴投注文本";
        return;
      }
      for (const row of draft.rows) {
        row.basePlayId ??= row.playId;
        row.baseMode ??= row.mode;
      }
      reviewOpen = true;
    } catch (e) {
      error = fail(e);
      draft.rows = [];
    }
  }
  function closeReview() {
    if (!busy) reviewOpen = false;
  }
  function bindAlias(alias: string, id: number) {
    for (const row of draft.rows)
      if (row.playLabel === alias && !row.excluded) {
        row.playId = id;
        row.basePlayId = id;
      }
  }
  function rowQuote(index: number) {
    const start = compiled
      .slice(0, index)
      .reduce((sum, r) => sum + r.items.length, 0);
    const quotes =
      previewKey === key
        ? (preview?.items.slice(start, start + compiled[index].items.length) ??
          [])
        : [];
    return {
      units: quotes.reduce((s, q) => s + q.units, 0),
      stake: quotes.reduce((s, q) => s + q.stake, 0),
      error: quotes.find((q) => q.error)?.error,
    };
  }
  function description(index: number) {
    return compiled[index].items
      .map((item) => {
        const rule = boot.plays.find((p) => p.id === item.play_id)!.rule;
        const kind =
          item.drag?.zodiac || item.package_zodiacs?.length
            ? "zodiac"
            : rule.kind;
        const names = (values: number[]) =>
          values.map((v) => label(kind, v)).join("、");
        return item.drag
          ? `${names(item.drag.left)} 拖 ${names(item.drag.right)}`
          : `${item.package_zodiacs?.length ? "包肖 " : ""}${names(item.package_zodiacs?.length ? item.package_zodiacs : item.selections)}${item.compound ? " · 复式" : ""}`;
      })
      .join("；");
  }
  // Any edit or account/period/rule change invalidates the quote immediately.
  // Only the latest complete draft can enable confirmation; closing aborts it.
  $effect(() => {
    const opened = reviewOpen;
    const valid = canPreview;
    const expected = key;
    const body = untrack(() => input);
    void retryCount;
    preview = null;
    previewKey = "";
    checking = false;
    reviewError = "";
    if (!opened || !valid) return;
    checking = true;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const result = await requests.api<Preview>("/slips/preview", {
          method: "POST",
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          preview = result;
          previewKey = expected;
        }
      } catch (e) {
        if (!controller.signal.aborted) reviewError = fail(e);
      } finally {
        if (!controller.signal.aborted) checking = false;
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  });
  async function submit() {
    if (!ready || busy) return;
    const selectedRate = rates.find((play) => play.id === rateChoice);
    const selectedRows = rateRows.filter((row) => row.playId === rateChoice);
    const modes = new Set(selectedRows.map((row) => row.mode));
    const bettor_preference =
      selectedRate && selectedRows.length
        ? {
            play_id: selectedRate.id,
            play_version: selectedRate.version,
            amount_mode: modes.size === 1 ? [...modes][0] : "auto",
          }
        : null;
    const text_preferences = confirmedPreferences(
      activeRows.filter(
        (row) =>
          !bettor_preference ||
          !selectedRows.includes(row) ||
          !genericSpecial.has(row.playLabel),
      ),
      boot.plays,
    );
    const body = {
      ...input,
      entry_mode: "text",
      ...(bettor_preference ? { bettor_preference } : {}),
      ...(text_preferences.length ? { text_preferences } : {}),
    };
    const bodyKey = JSON.stringify(body);
    if (!draft.pending || draft.pending.key !== bodyKey)
      draft.pending = { key: bodyKey, id: crypto.randomUUID() };
    busy = true;
    reviewError = "";
    try {
      await requests.api("/slips", {
        method: "POST",
        body: JSON.stringify({ ...body, request_id: draft.pending.id }),
      });
      draft.raw = "";
      draft.recognized = "";
      draft.rows = [];
      draft.pending = null;
      preview = null;
      previewKey = "";
      reviewOpen = false;
      notify("整份文本已作为一张投注单入账");
      await loadPreferences();
      await onrecorded();
    } catch (e) {
      if (reviewOpen) reviewError = fail(e);
      else error = fail(e);
    } finally {
      busy = false;
    }
  }
  async function forget(alias: string) {
    busy = true;
    error = "";
    try {
      await requests.api(
        `/text-entry/preferences/${encodeURIComponent(alias)}`,
        { method: "DELETE" },
      );
      await loadPreferences();
    } catch (e) {
      error = fail(e);
    } finally {
      busy = false;
    }
  }
</script>

<section class="glass text-entry" aria-label="文本录注" aria-busy={busy}>
  <div class="section-head"><h2><FileText size={19} />文本录注</h2></div>
  <label class="text-source"
    >投注原文<textarea
      bind:value={draft.raw}
      disabled={busy}
      rows="7"
      placeholder="例如：特码：07、18各25元；三有：牛龙羊260元"
    ></textarea></label
  >
  <div class="text-entry-actions">
    <button
      class="button primary"
      disabled={busy || !preferencesReady || !draft.raw.trim()}
      onclick={checkText}><ScanText size={16} />校验</button
    >
    {#if !preferencesReady && error}<button
        class="button secondary"
        disabled={busy}
        onclick={loadPreferences}>重试加载习惯</button
      >{/if}
  </div>
  {#if error}<p class="form-error" role="alert">{error}</p>{/if}
  {#if preferences.length}<details class="text-habits">
      <summary>已记住的习惯（{preferences.length}）</summary>
      <ul>
        {#each preferences as preference}<li>
            <span
              >{preference.alias} → {boot.plays.find(
                (p) => p.id === preference.play_id,
              )?.rule.name ?? "已删除的玩法"}<small
                >{{
                  auto: "原文金额",
                  each: "每注金额",
                  package: "每肖包号",
                  total: "片段总额",
                }[preference.amount_mode]}{boot.plays.some(
                  (p) =>
                    p.id === preference.play_id &&
                    p.version === preference.play_version &&
                    p.enabled,
                )
                  ? ""
                  : " · 已失效，须重新确认"}</small
              ></span
            ><button
              class="text-button"
              disabled={busy}
              onclick={() => forget(preference.alias)}
              aria-label={`忘记${preference.alias}`}
              ><RotateCcw size={14} />忘记</button
            >
          </li>{/each}
      </ul>
    </details>{/if}
</section>

{#if reviewOpen}
  <Modal title="确认投注单" wide dismissible={!busy} onclose={closeReview}>
    <div class="text-review" bind:this={reviewContent}>
      <div class="text-review-heading">
        <label
          >投注人<input
            bind:value={draft.bettor}
            maxlength="80"
            disabled={busy}
            placeholder="填写投注人"
            aria-invalid={!draft.bettor.trim()}
          /></label
        >
        <span>第 {today.id} 期 · {activeRows.length} 项投注</span>
      </div>
      {#if rateRows.length}<label class="text-rate-choice"
          >特码费率<select
            aria-label="特码费率"
            value={rateChoice}
            disabled={busy || rateLoading}
            onchange={(event) => chooseRate(Number(event.currentTarget.value))}
          >
            <option value={0}>按各项原文</option>
            {#each rates as play}<option value={play.id}
                >{play.rule.name} · 赔率 {play.rule.odds} · 水位 {play.rule
                  .rebate_percent}%</option
              >{/each}
          </select></label
        >{/if}
      {#if rateLoading}<p class="text-rate-status" role="status">
          正在匹配投注人费率…
        </p>{/if}
      {#if rateError}<p class="form-error" role="alert">
          {rateError}<button
            type="button"
            class="text-button"
            onclick={() => {
              reviewOpen = false;
              void tick().then(() => (reviewOpen = true));
            }}>重试</button
          >
        </p>{/if}
      {#if aliases.length}<div class="text-aliases" aria-label="本单玩法对应">
          {#each aliases as alias}<label
              >“{alias}”对应玩法<select
                value={draft.rows.find(
                  (r) => r.playLabel === alias && !r.excluded,
                )?.playId || 0}
                disabled={busy}
                aria-invalid={!draft.rows.find(
                  (row) => row.playLabel === alias && !row.excluded,
                )?.playId}
                onchange={(e) =>
                  bindAlias(alias, Number(e.currentTarget.value))}
              >
                <option value={0}>请选择玩法</option>
                {#each playCandidates(alias, boot.plays) as candidate}<option
                    value={candidate.play.id}
                    >{candidate.play.rule.name}{candidate.suggested
                      ? " · 建议"
                      : ""}</option
                  >{/each}
              </select></label
            >{/each}
        </div>{/if}
      <ol class="text-entry-rows">
        {#each draft.rows as row, index (row.key)}
          {@const quote = rowQuote(index)}
          <li
            data-row-index={index}
            class:has-error={!!compiled[index].error || !!quote.error}
            class:excluded={row.excluded}
          >
            <div class="text-original">
              <span>原文 {index + 1}</span>
              <blockquote>{row.source}</blockquote>
            </div>
            <div class="text-correction">
              <div class="text-row-heading">
                <strong
                  >{boot.plays.find((p) => p.id === row.playId)?.rule.name ??
                    "待确认玩法"}</strong
                >
                {#if row.excluded}<span class="text-row-state">不录入</span>
                {:else if compiled[index].error || quote.error}<span
                    class="text-row-state attention"
                    ><AlertCircle size={14} />待处理</span
                  >{/if}
                <button
                  type="button"
                  class="icon-button"
                  aria-label={`移除第${index + 1}项`}
                  title="移除此项"
                  disabled={busy}
                  onclick={() => removeRow(index)}><Trash2 size={16} /></button
                >
              </div>
              {#if row.customAlias}<label
                  >未识别的玩法简称（可选）<input
                    bind:value={row.playLabel}
                    maxlength="40"
                    disabled={busy}
                    placeholder="确认后可记住此简称"
                  /></label
                ><label
                  >对应玩法<select
                    bind:value={row.playId}
                    onchange={(event) => {
                      row.playId = Number(event.currentTarget.value);
                      row.basePlayId = row.playId;
                      const ids = new Set(rateRows.map((item) => item.playId));
                      rateChoice = ids.size === 1 ? [...ids][0] : 0;
                    }}
                    disabled={busy}
                    aria-invalid={!row.excluded && !row.playId}
                    ><option value={0}>请选择玩法</option
                    >{#each boot.plays.filter((p) => p.enabled) as play}<option
                        value={play.id}>{play.rule.name}</option
                      >{/each}</select
                  ></label
                >{/if}
              <label
                >投注项<textarea
                  aria-label={`第${index + 1}项投注项`}
                  bind:value={row.body}
                  oninput={(event) =>
                    (row.excluded = !event.currentTarget.value.trim())}
                  rows="2"
                  disabled={busy}
                  aria-invalid={!!quote.error ||
                    (!!compiled[index].error &&
                      !compiled[index].error.startsWith("请确认") &&
                      entryCents(row.amount) !== null &&
                      !compiled[index].error.includes("歧义"))}
                  aria-describedby={compiled[index].error || quote.error
                    ? `text-row-error-${index}`
                    : undefined}
                ></textarea></label
              >
              <div class="form-two">
                <label
                  >金额（元）<input
                    aria-label={`第${index + 1}项金额`}
                    bind:value={row.amount}
                    inputmode="decimal"
                    aria-invalid={!row.excluded &&
                      entryCents(row.amount) === null}
                    maxlength="15"
                    disabled={busy}
                  /></label
                >
                <label
                  >金额含义<select
                    aria-label={`第${index + 1}项金额含义`}
                    bind:value={row.mode}
                    aria-invalid={compiled[index].error.includes("歧义")}
                    disabled={busy || !!row.marker}
                  >
                    <option value="auto">按原文确认</option><option value="each"
                      >每注／每号金额</option
                    ><option value="package">每肖包号金额</option><option
                      value="total">本片段总金额</option
                    >
                  </select></label
                >
              </div>

              {#if compiled[index].error || quote.error}<p
                  id={`text-row-error-${index}`}
                  class="form-error"
                  role="alert"
                >
                  {compiled[index].error || quote.error}
                </p>{:else if compiled[index].items.some((item) => item.compound || item.drag || item.package_zodiacs?.length)}<p
                  class="text-interpretation"
                >
                  {description(index)}
                </p>{/if}
              {#if !row.excluded && previewKey === key && !quote.error && !compiled[index].error}<strong
                  >{quote.units} 注 · 本金 {money(quote.stake)}</strong
                >{/if}
            </div>
          </li>
        {/each}
      </ol>

      {#if items.length > 100}<p class="form-error" role="alert">
          整单超过 100 个分项，请返回修改原文。
        </p>{/if}
      {#if !today.accepting_entries}<p class="form-error" role="alert">
          当前期次不能录入，请返回刷新期次。
        </p>{/if}
      {#if previewKey === key && preview?.error}<p
          class="form-error"
          role="alert"
        >
          {preview.error}
        </p>{/if}
      {#if reviewError}<p class="form-error" role="alert">{reviewError}</p>{/if}
    </div>
    {#snippet footer()}
      <div
        class="text-review-total"
        class:needs-attention={!ready && !checking && !busy}
        aria-live="polite"
        aria-busy={checking}
      >
        {#if ready}<span>{items.length} 个分项 · {preview!.units} 注</span
          ><strong>{money(preview!.stake)}</strong>
        {:else if checking}<span
            ><LoaderCircle class="spin" size={16} />正在校验投注单</span
          >
        {:else if !activeRows.length}<span
            ><AlertCircle size={18} />没有可录入的投注项</span
          >
        {:else if !draft.bettor.trim()}<button
            type="button"
            class="text-attention"
            onclick={focusIssue}><AlertCircle size={18} />请填写投注人</button
          >
        {:else if issues.length}<button
            type="button"
            class="text-attention"
            onclick={focusIssue}
            ><AlertCircle size={18} />请处理第 {issues
              .map((i) => i + 1)
              .join("、")} 项</button
          >
        {:else if !canPreview}<span
            ><AlertCircle size={18} />请核对投注项与当前期次</span
          >
        {:else}<span><AlertCircle size={18} />校验未通过</span>{/if}
      </div>
      <div class="modal-actions">
        <button class="button secondary" disabled={busy} onclick={closeReview}
          >返回修改</button
        >
        {#if reviewError && canPreview}<button
            class="button secondary"
            disabled={busy || checking}
            onclick={() => retryCount++}>重新校验</button
          >{/if}
        <button
          class="button primary"
          disabled={busy || !ready}
          onclick={submit}
          >{#if busy}<LoaderCircle
              class="spin"
              size={16}
            />录入中…{:else}确认录入{/if}</button
        >
      </div>
    {/snippet}
  </Modal>
{/if}
