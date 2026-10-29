<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { FileText, ScanText, ArrowRight, RotateCcw } from "lucide-svelte";
  import { money, label } from "../lib/types";
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
  let reviewed = $state(false);
  const compiled = $derived(
    draft.rows.map((row) => compileRow(row, boot.plays, today.mapping)),
  );
  const items = $derived(compiled.flatMap((row) => row.items));
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
      remember: draft.remember,
    }),
  );
  const parsed = $derived(
    draft.raw === draft.recognized && draft.rows.length > 0,
  );
  const canPreview = $derived(
    parsed &&
      !!draft.bettor.trim() &&
      items.length > 0 &&
      items.length <= 100 &&
      compiled.every((row) => !row.error) &&
      today.accepting_entries,
  );
  const ready = $derived(
    canPreview && previewKey === key && preview?.valid === true,
  );
  const aliases = $derived([
    ...new Set(draft.rows.filter((r) => r.playLabel).map((r) => r.playLabel)),
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
  function recognize() {
    error = "";
    preview = null;
    previewKey = "";
    reviewed = false;
    try {
      draft.rows = parseText(draft.raw, boot.plays, preferences);
      draft.recognized = draft.raw;
      if (!draft.rows.length) error = "请粘贴投注文本";
    } catch (e) {
      error = fail(e);
      draft.rows = [];
    }
  }
  function bindAlias(alias: string, id: number) {
    for (const row of draft.rows) if (row.playLabel === alias) row.playId = id;
    reviewed = false;
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
  async function validate() {
    if (!canPreview || busy) return;
    busy = true;
    error = "";
    reviewed = false;
    const expected = key;
    try {
      const result = await requests.api<Preview>("/slips/preview", {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (key === expected) {
        preview = result;
        previewKey = expected;
      }
    } catch (e) {
      error = fail(e);
    } finally {
      busy = false;
    }
  }
  async function submit() {
    if (!ready || !reviewed || busy) return;
    const text_preferences = draft.remember
      ? confirmedPreferences(draft.rows, boot.plays)
      : [];
    const body = {
      ...input,
      ...(text_preferences.length ? { text_preferences } : {}),
    };
    const bodyKey = JSON.stringify(body);
    if (!draft.pending || draft.pending.key !== bodyKey)
      draft.pending = { key: bodyKey, id: crypto.randomUUID() };
    busy = true;
    error = "";
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
      reviewed = false;
      notify("整份文本已作为一张投注单入账");
      await loadPreferences();
      await onrecorded();
    } catch (e) {
      error = fail(e);
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
  <div class="section-head">
    <h2><FileText size={19} />文本录注</h2>
    <span class="soft-chip">一份文本 · 一张投注单</span>
  </div>
  <p class="field-help">本地识别，核对后整单录入。无法确认的内容不会跳过。</p>
  <label
    >投注人<input
      bind:value={draft.bettor}
      maxlength="80"
      disabled={busy}
      placeholder="填写投注人"
    /></label
  >
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
      onclick={recognize}><ScanText size={16} />识别整单</button
    >
    {#if !preferencesReady}<button
        class="button secondary"
        disabled={busy}
        onclick={loadPreferences}>重试加载习惯</button
      >{/if}
    {#if draft.rows.length}<span>{draft.rows.length} 个原文片段</span>{/if}
  </div>
  {#if draft.rows.length && !parsed}<p class="form-error" role="alert">
      原文已修改，请重新识别整单。
    </p>{/if}
  {#if parsed}
    {#if aliases.length}<div class="text-aliases" aria-label="本单玩法对应">
        {#each aliases as alias}<label
            >“{alias}”对应玩法<select
              value={draft.rows.find((r) => r.playLabel === alias)?.playId || 0}
              disabled={busy}
              onchange={(e) => bindAlias(alias, Number(e.currentTarget.value))}
            >
              <option value={0}>请选择，不自动猜测</option>
              {#each playCandidates(alias, boot.plays) as candidate}<option
                  value={candidate.play.id}
                  >{candidate.play.rule.name}{candidate.suggested
                    ? " · 样本建议，需确认"
                    : ""}</option
                >{/each}
            </select></label
          >{/each}
      </div>{/if}
    <ol class="text-entry-rows">
      {#each draft.rows as row, index (row.key)}
        {@const quote = rowQuote(index)}
        <li class:has-error={!!compiled[index].error || !!quote.error}>
          <div class="text-original">
            <span>原文 {index + 1}</span>
            <blockquote>{row.source}</blockquote>
          </div>
          <div class="text-correction">
            {#if row.customAlias}<label
                >未识别的玩法简称（可选）<input
                  bind:value={row.playLabel}
                  maxlength="40"
                  disabled={busy}
                  placeholder="确认后可记住此简称"
                /></label
              ><label
                >对应玩法<select bind:value={row.playId} disabled={busy}
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
                rows="2"
                disabled={busy}
                aria-invalid={!!compiled[index].error || !!quote.error}
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
                  maxlength="15"
                  disabled={busy}
                /></label
              >
              <label
                >金额含义<select
                  aria-label={`第${index + 1}项金额含义`}
                  bind:value={row.mode}
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
            {#if row.marker}<small class="field-help"
                >原文金额标记：{row.marker}；要改变含义请修改原文后重新识别。</small
              >{/if}
            {#if compiled[index].error || quote.error}<p
                id={`text-row-error-${index}`}
                class="form-error"
                role="alert"
              >
                {compiled[index].error || quote.error}
              </p>{:else}<p class="text-interpretation">
                {description(index)}
              </p>{/if}
            {#if previewKey === key && !quote.error && !compiled[index].error}<strong
                >{quote.units} 注 · 本金 {money(quote.stake)}</strong
              >{/if}
          </div>
        </li>
      {/each}
    </ol>
    <label class="text-confirm"
      ><input
        type="checkbox"
        bind:checked={draft.remember}
        disabled={busy}
      />确认录入后，记住本账号的玩法简称与金额习惯</label
    >
    {#if items.length > 100}<p class="form-error" role="alert">
        整单超过 100 个分项，不能自动拆单。
      </p>{/if}
    <div class="text-entry-actions">
      <button
        class="button secondary"
        disabled={busy || !canPreview}
        onclick={validate}>校验并预览整单 <ArrowRight size={16} /></button
      >
    </div>
    {#if previewKey === key && preview}
      {#if preview.error}<p class="form-error" role="alert">
          {preview.error}
        </p>{/if}
      {#if ready}<div class="slip-total">
          <span>1 张投注单 · {items.length} 个分项 · {preview.units} 注</span
          ><strong>{money(preview.stake)}</strong>
        </div>
        <label class="text-confirm"
          ><input
            type="checkbox"
            bind:checked={reviewed}
            disabled={busy}
          />已逐项核对玩法、选项和总金额</label
        >
      {/if}
    {:else}<p class="field-help">
        修改草稿、切期或玩法变化后，须重新预览。
      </p>{/if}
    <button
      class="button primary"
      disabled={busy || !ready || !reviewed}
      onclick={submit}>{busy ? "处理中…" : "确认录入整单"}</button
    >
  {/if}
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
