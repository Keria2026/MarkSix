<script lang="ts">
  import DragPicker from "./DragPicker.svelte";
  import { dragAvailable, dragPreview, dragLabel } from "../lib/drag";
  import { onDestroy, untrack } from "svelte";
  import {
    AlertCircle,
    CheckCircle2,
    Check,
    ChevronDown,
    Clock3,
    LoaderCircle,
    Plus,
    ReceiptText,
  } from "lucide-svelte";
  import {
    money,
    entryCents,
    label,
    options,
    basicCount,
    selectionBoundary,
    wave,
    zodiacs,
    kinds,
    scopes,
    conditions,
    relations,
  } from "../lib/types";
  import type {
    Bootstrap,
    Period,
    BetDraft,
    SlipDraftLine,
    api as Api,
  } from "../lib/types";
  import { createRequestScope } from "../lib/requests";
  import { parseSelections } from "../lib/selection";
  let {
    boot,
    draft = $bindable(),
    today,
    api: accountApi,
    notify,
    onrecorded,
    onconfigure,
    onadd,
  }: {
    boot: Bootstrap;
    draft: BetDraft;
    today: Period;
    api: typeof Api;
    notify: (message: string) => void;
    onrecorded: () => Promise<void>;
    onconfigure: () => Promise<void>;
    onadd: (line: SlipDraftLine) => boolean;
  } = $props();
  // Abort submission responses when leaving this form as well as logout.
  const requests = createRequestScope(
    () => {},
    (path, options) => accountApi(path, options),
  );
  const entryPeriod = $derived(
    draft.market === "hk"
      ? boot.hk?.accepting_entries
        ? boot.hk
        : undefined
      : today,
  );
  const entryUnits = $derived(entryPeriod?.totals.units ?? 0);
  const entryMapping = $derived(
    draft.market === "hk"
      ? boot.hk?.accepting_entries
        ? boot.hk.mapping
        : today.mapping
      : today.mapping,
  );
  const api = requests.api;
  onDestroy(requests.dispose);
  let busy = $state(false),
    selectionError = $state("");
  let selectionText = $state("");
  let textInvalid = $state(false);
  function boundary(values: number[]) {
    if (!currentPlay) return null;
    const selected = draft.packageMode
      ? entryMapping.zodiac.flatMap((z, i) =>
          values.includes(z) ? [i + 1] : [],
        )
      : values;
    return selectionBoundary(currentPlay.rule, selected, draft.compound);
  }
  function setPackageMode(value: boolean) {
    draft.drag = null;
    draft.packageMode = value;
    draft.compound = false;
    draft.selections = [];
    selectionError = "";
    syncSelectionText();
  }
  function syncSelectionText() {
    selectionText = currentPlay
      ? draft.selections.map((value) => label(selectionKind, value)).join(" ")
      : "";
    textInvalid = false;
  }
  function enterSelections(value: string) {
    selectionText = value;
    if (!currentPlay) return;
    try {
      const next = parseSelections(selectionKind, value);
      if (
        currentPlay.rule.kind === "zodiac_count" &&
        next.some((n) => n !== currentPlay.rule.zodiac_count)
      )
        throw new Error(`本玩法只允许 ${currentPlay.rule.zodiac_count} 种生肖`);
      const error = boundary(next);
      if (error) throw new Error(error);
      draft.selections = next;
      selectionError = "";
      textInvalid = false;
    } catch (e) {
      selectionError = fail(e);
      textInvalid = true;
    }
  }
  function fail(e: unknown) {
    return e instanceof Error ? e.message : "操作失败，请重试";
  }
  const matchingPlays = $derived(
    boot?.plays.filter(
      (p) =>
        p.enabled &&
        p.rule.name
          .toLocaleLowerCase()
          .includes(draft.playSearch.trim().toLocaleLowerCase()),
    ) ?? [],
  );
  const currentPlay = $derived(
    boot?.plays.find((p) => p.id === draft.playId && p.enabled) ??
      boot?.plays.find((p) => p.enabled),
  );
  const selectionKind = $derived(
    draft.packageMode ? "zodiac" : (currentPlay?.rule.kind ?? "number"),
  );
  const packageAvailable = $derived(
    currentPlay?.rule.kind === "number" && currentPlay.rule.quantity === 1,
  );
  const packageNumbers = $derived(
    entryMapping.zodiac.flatMap((z, i) =>
      draft.selections.includes(z) ? [i + 1] : [],
    ),
  );
  $effect(() => {
    const kind = selectionKind;
    const selections = [...draft.selections];
    untrack(() => {
      if (!kind || textInvalid) return;
      try {
        const typed = parseSelections(kind, selectionText);
        if (
          typed.length !== selections.length ||
          typed.some((n, i) => n !== selections[i])
        )
          syncSelectionText();
      } catch {
        textInvalid = true;
        selectionError = "玩法选项已变化，请清空后重新选择投注项";
      }
    });
  });
  const dragging = $derived(
    currentPlay && draft.drag
      ? dragPreview(currentPlay.rule, draft.drag, entryMapping)
      : null,
  );
  const selectedCount = $derived(
    dragging
      ? dragging.units
      : currentPlay
        ? basicCount(
            currentPlay.rule,
            draft.packageMode ? packageNumbers : draft.selections,
            draft.compound,
          )
        : 0,
  );
  const inputValid = $derived(
    !!currentPlay &&
      (!draft.packageMode || packageAvailable) &&
      (draft.drag ? !!dragging?.input : !textInvalid) &&
      selectedCount > 0 &&
      selectedCount <= 1000 &&
      entryCents(draft.amount) !== null,
  );
  const stakePreview = $derived(
    (entryCents(draft.amount) ?? 0n) *
      BigInt(draft.packageMode ? draft.selections.length : selectedCount),
  );
  const submissionBody = $derived(
    inputValid && today && currentPlay
      ? JSON.stringify({
          period: today.id,
          ...(draft.market === "hk" ? { market: draft.market } : {}),
          play_id: currentPlay.id,
          play_version: currentPlay.version,
          ...(draft.packageMode
            ? { package_zodiacs: [...draft.selections].sort((a, b) => a - b) }
            : {}),
          ...(dragging?.input ? { drag: dragging.input } : {}),
          selections:
            draft.drag || draft.packageMode
              ? []
              : currentPlay.rule.condition === "hard_pair"
                ? [...draft.selections]
                : [...draft.selections].sort((a, b) => a - b),
          bettor: draft.bettor.trim(),
          compound: draft.compound,
          amount: draft.amount,
          request_id: "00000000-0000-4000-8000-000000000001",
        })
      : "",
  );
  function selectPlay(value: number) {
    if (draft.playId === value) return;
    draft.playId = value;
    const selectedRule = boot?.plays.find((play) => play.id === value)?.rule;
    draft.selections =
      selectedRule?.kind === "zodiac_count" && selectedRule.zodiac_count != null
        ? [selectedRule.zodiac_count]
        : [];
    draft.compound = false;
    draft.packageMode = false;
    draft.drag = null;
    selectionError = "";
    syncSelectionText();
  }
  function setDrag() {
    draft.drag = { left: "", right: "", zodiac: false };
    draft.compound = true;
    draft.packageMode = false;
    draft.selections = [];
    selectionError = "";
    syncSelectionText();
  }
  function clearSelection() {
    draft.selections = [];
    if (draft.drag) draft.drag = { ...draft.drag, left: "", right: "" };
    syncSelectionText();
  }
  function setCompound(next: boolean) {
    if (currentPlay) {
      const error = selectionBoundary(currentPlay.rule, draft.selections, next);
      if (error) {
        selectionError = error;
        notify(error);
        return;
      }
    }
    selectionError = "";
    draft.compound = next;
    draft.drag = null;
  }
  function toggleOption(value: number) {
    if (draft.selections.includes(value)) {
      draft.selections = draft.selections.filter((n) => n !== value);
      selectionError = "";
      syncSelectionText();
      return;
    }
    const next = [...draft.selections, value];
    const error = currentPlay ? boundary(next) : null;
    if (error) {
      selectionError = error;
      notify(error);
      return;
    }
    selectionError = "";
    draft.selections = next;
    syncSelectionText();
  }
  function matchPlay() {
    const exact = matchingPlays.find(
      (p) => p.rule.name === draft.playSearch.trim(),
    );
    if (exact || matchingPlays.length === 1)
      selectPlay((exact ?? matchingPlays[0]).id);
  }
  async function submitBet() {
    if (!inputValid || !submissionBody || !draft.bettor.trim()) return;
    busy = true;
    const body = JSON.parse(submissionBody);
    delete body.request_id;
    const key = JSON.stringify(body);
    if (!draft.pendingSubmission || draft.pendingSubmission.key !== key)
      draft.pendingSubmission = { key, id: crypto.randomUUID() };
    try {
      await api("/bets", {
        method: "POST",
        body: JSON.stringify({
          ...body,
          request_id: draft.pendingSubmission.id,
        }),
      });
      draft.pendingSubmission = null;
      clearSelection();
      notify(
        entryPeriod?.draw
          ? "投注已记录并按本期开奖结果结算"
          : "投注已记录，等待开奖结算",
      );
      await onrecorded();
    } catch (e) {
      notify(fail(e));
    } finally {
      busy = false;
    }
  }
  const validAmount = $derived(entryCents(draft.amount) !== null);
</script>

<label
  >投注市场<select
    aria-label="投注市场"
    value={draft.market ?? "macau"}
    disabled={busy}
    onchange={(event) => {
      draft.market = event.currentTarget.value as "macau" | "hk";
      draft.pendingSubmission = null;
    }}
    ><option value="macau">新澳门</option><option value="hk">香港</option
    ></select
  ></label
>

<div class="bet-layout">
  <section class="bet-form glass">
    <div class="section-head">
      <h2><span class="step">01</span> 选择玩法</h2>
    </div>
    <label class="play-search"
      >搜索玩法名称<input
        type="search"
        bind:value={draft.playSearch}
        oninput={(event) => {
          draft.playSearch = event.currentTarget.value;
          matchPlay();
        }}
        placeholder="输入名称自动匹配，按 Enter 选择"
        onkeydown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            matchPlay();
          }
        }}
      /></label
    >
    {#if draft.playSearch && !matchingPlays.length}<p class="field-help">
        没有匹配的玩法，请检查名称或在配置页创建。
      </p>{/if}
    <div class="play-picker">
      {#each draft.pickerExpanded || draft.playSearch.trim() ? matchingPlays : matchingPlays.slice(0, 6) as play}<button
          class:selected={currentPlay?.id === play.id}
          onclick={() => selectPlay(play.id)}
          ><span>{play.rule.name}</span><small
            >{kinds[play.rule.kind]} · {play.rule.odds} 倍</small
          >{#if currentPlay?.id === play.id}<CheckCircle2
              size={15}
            />{/if}</button
        >{/each}
    </div>
    {#if matchingPlays.length > 6 && !draft.playSearch.trim()}<button
        class="text-button picker-toggle"
        aria-expanded={draft.pickerExpanded}
        onclick={() => (draft.pickerExpanded = !draft.pickerExpanded)}
        >{draft.pickerExpanded
          ? "收起玩法列表"
          : `展开全部 ${matchingPlays.length} 个玩法`}<ChevronDown
          size={15}
        /></button
      >{/if}
    {#if currentPlay && !draft.pickerExpanded && !draft.playSearch.trim() && !matchingPlays
        .slice(0, 6)
        .some((p) => p.id === currentPlay.id)}<p class="field-help">
        当前玩法：{currentPlay.rule.name}
      </p>{/if}
    {#if !currentPlay}<div class="empty-state">
        <p>尚未配置可用玩法。</p>
        <button class="button secondary" onclick={onconfigure}>配置玩法</button>
      </div>{:else}<div class="rule-strip">
        <span><small>对比范围</small>{scopes[currentPlay.rule.scope]}</span
        ><span
          ><small>命中条件</small>{conditions[currentPlay.rule.condition]}</span
        ><span
          ><small>基础注数量</small>{relations[currentPlay.rule.relation]}
          {currentPlay.rule.quantity} 个</span
        ><span><small>反水</small>{currentPlay.rule.rebate_percent}%</span>
      </div>
      <div class="section-head selection-heading">
        <h2><span class="step">02</span> 选择投注项</h2>
        {#if currentPlay.rule.compound_enabled && !draft.packageMode}<div
            class="segmented"
          >
            <button
              class:active={!draft.compound && !draft.drag}
              aria-pressed={!draft.compound && !draft.drag}
              onclick={() => setCompound(false)}>普通 / 多选</button
            ><button
              class:active={draft.compound && !draft.drag}
              aria-pressed={draft.compound && !draft.drag}
              onclick={() => setCompound(true)}>复式</button
            >{#if dragAvailable(currentPlay.rule)}<button
                class:active={!!draft.drag}
                aria-pressed={!!draft.drag}
                onclick={setDrag}>拖</button
              >{/if}
          </div>{/if}
      </div>
      {#if packageAvailable}<div class="segmented" aria-label="号码投注方式">
          <button
            class:active={!draft.packageMode}
            aria-pressed={!draft.packageMode}
            onclick={() => setPackageMode(false)}>直接选号</button
          >
          <button
            class:active={draft.packageMode}
            aria-pressed={draft.packageMode}
            onclick={() => setPackageMode(true)}>包肖投注</button
          >
        </div>{/if}

      {#if currentPlay.rule.condition === "hard_pair"}<p class="field-help">
          特码 → 平码：{draft.selections
            .map((n) => label("number", n))
            .join(" → ") || "未选择"}
        </p>{/if}

      {#if draft.drag}<DragPicker
          rule={currentPlay.rule}
          mapping={entryMapping}
          bind:draft={draft.drag}
        />{:else}
        <div class="selection-description">
          <button
            class="text-button"
            onclick={() => {
              draft.selections = [];
              selectionError = "";
              syncSelectionText();
            }}
            disabled={!draft.selections.length && !selectionText}
            >清空选择</button
          >
        </div>
        <label class="play-search selection-input"
          >输入投注项<input
            type="text"
            maxlength="2048"
            value={selectionText}
            aria-invalid={textInvalid}
            aria-describedby={selectionError ? "selection-error" : undefined}
            oninput={(event) => enterSelections(event.currentTarget.value)}
            onkeydown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                enterSelections(event.currentTarget.value);
              }
            }}
            placeholder={selectionKind === "number"
              ? "例如：01 02，03、04"
              : selectionKind === "zodiac"
                ? "例如：鼠 牛，虎、兔"
                : "输入选项，以空格或标点分隔"}
          /></label
        >

        <div
          class="option-grid"
          class:number-grid={selectionKind === "number"}
          class:zodiac-grid={selectionKind === "zodiac"}
        >
          {#each options(selectionKind).filter((value) => currentPlay.rule.kind !== "zodiac_count" || value === currentPlay.rule.zodiac_count) as value}<button
              class="option"
              class:selected={draft.selections.includes(value)}
              aria-pressed={draft.selections.includes(value)}
              aria-label={`${label(selectionKind, value)}${selectionKind === "number" ? ` ${zodiacs[entryMapping.zodiac[value - 1]]}` : ""}`}
              onclick={() => toggleOption(value)}
              >{#if selectionKind === "number"}<span
                  class="number-option"
                  data-wave={wave(value)}>{label(selectionKind, value)}</span
                ><small>{zodiacs[entryMapping.zodiac[value - 1]]}</small
                >{:else}<span>{label(selectionKind, value)}</span
                >{#if selectionKind === "zodiac" && value === entryMapping.natal}<small
                    >本命</small
                  >{/if}{/if}{#if draft.selections.includes(value)}<span
                  class="selection-check"><Check size={10} /></span
                >{/if}</button
            >{/each}
        </div>
        {#if selectionError}<p
            id="selection-error"
            class="inline-error"
            role="alert"
          >
            {selectionError}
          </p>{/if}
        <div class="selection-meta">
          {#if currentPlay.rule.zero_tail_rebate_percent != null}<span
              >含 0 尾基础注反水 <strong
                >{currentPlay.rule.zero_tail_rebate_percent}</strong
              >%</span
            >{/if}
          {#if currentPlay.rule.zero_tail_odds != null}<span
              >含 0 尾基础注赔率 <strong
                >{currentPlay.rule.zero_tail_odds}</strong
              > 倍</span
            >{/if}
          <span>已选 <strong>{draft.selections.length}</strong> 项</span
          >{#if currentPlay.rule.special_odds}<span
              >含本命生肖基础注赔率 <strong
                >{currentPlay.rule.special_odds}</strong
              > 倍</span
            >{/if}
        </div>
      {/if}
      <div class="section-head amount-heading">
        <h2><span class="step">03</span> 填写金额</h2>
        <span class="muted small"
          >{draft.packageMode
            ? "每肖总本金，逐号均分"
            : "每条基础注的本金"}</span
        >
      </div>
      <label class="bettor-input"
        >投注人<input
          bind:value={draft.bettor}
          list="bettor-suggestions"
          maxlength="80"
          autocomplete="off"
          placeholder="手工填写姓名或代号"
          required
        /></label
      >
      <label class="amount-input"
        ><span>¥</span><input
          aria-label={draft.packageMode ? "每肖金额" : "每注金额"}
          inputmode="decimal"
          pattern="[0-9]+([.][0-9])?"
          bind:value={draft.amount}
          maxlength="16"
        /><small>{draft.packageMode ? "元 / 肖" : "元 / 注"}</small></label
      >
      <div class="quick-amounts">
        {#each ["10", "50", "100", "500", "1000"] as value}<button
            class:active={draft.amount === value}
            onclick={() => (draft.amount = value)}>{value} 元</button
          >{/each}
      </div>{/if}
  </section>
  <aside class="bet-summary glass">
    <div class="section-head">
      <div>
        <h2>本次投注</h2>
      </div>
      <ReceiptText size={21} class="muted" />
    </div>
    <div class="summary-name">
      {currentPlay?.rule.name ?? "选择一个玩法"}<span class="soft-chip"
        >{draft.drag
          ? "拖"
          : draft.packageMode
            ? "包肖"
            : draft.compound
              ? "复式"
              : selectedCount > 1
                ? "多选"
                : "单注"}</span
      >
    </div>
    <div class="selected-tags">
      {#if dragging?.input && currentPlay}<p>
          {dragLabel(currentPlay.rule.kind, dragging.input)}
        </p>{:else if draft.selections.length}{#each draft.selections.slice(0, 20) as value}<span
            >{label(selectionKind, value)}</span
          >{/each}{#if draft.selections.length > 20}<span
            >+{draft.selections.length - 20}</span
          >{/if}{:else}<p>尚未选择投注项</p>{/if}
    </div>
    {#if draft.packageMode}<p class="field-help">
        包号：{packageNumbers.map((n) => label("number", n)).join(" · ")}
      </p>{/if}
    <div class="ledger-row">
      <span>基础注数量</span><strong>{selectedCount.toLocaleString()} 注</strong
      >
    </div>
    <div class="ledger-row">
      <span>{draft.packageMode ? "每肖本金" : "每注本金"}</span><strong
        >{validAmount ? money(entryCents(draft.amount)!) : "—"}</strong
      >
    </div>
    <div class="summary-total">
      <span>总投注本金</span><strong>{money(stakePreview)}</strong>
    </div>
    {#if selectedCount > 1000}<div class="inline-error">
        <AlertCircle size={15} />单次最多 1000 条基础注，请减少选项。
      </div>{/if}{#if !today.accepting_entries}<div
        class="notice compact-notice"
      >
        <Clock3 size={16} /><span>本期已归档，请刷新后录入当前期。</span>
      </div>{/if}<button
      class="button primary submit-bet"
      disabled={busy ||
        !inputValid ||
        !draft.bettor.trim() ||
        !today.accepting_entries}
      onclick={submitBet}
      >{#if busy}<LoaderCircle size={17} class="spin" />{:else}<Plus
          size={17}
        />{/if}确认录入投注</button
    >
    <button
      class="button secondary submit-bet"
      disabled={busy ||
        !inputValid ||
        !draft.bettor.trim() ||
        !today.accepting_entries}
      onclick={() => {
        if (!currentPlay || !inputValid) return;
        const added = onadd({
          key: crypto.randomUUID(),
          rule: structuredClone($state.snapshot(currentPlay.rule)),
          ...(draft.market === "hk" ? { market: draft.market } : {}),
          play_id: currentPlay.id,
          play_version: currentPlay.version,
          selections:
            draft.drag || draft.packageMode ? [] : [...draft.selections],
          ...(dragging?.input ? { drag: structuredClone(dragging.input) } : {}),
          ...(draft.packageMode
            ? { package_zodiacs: [...draft.selections] }
            : {}),
          compound: draft.compound,
          amount: draft.amount,
          units: selectedCount,
        });
        if (added) {
          clearSelection();
          draft.pendingSubmission = null;
        }
      }}>加入组合单</button
    >
    <div class="quota">
      <span>本期容量</span><small
        >{entryUnits.toLocaleString()} / 10,000 基础注</small
      >
      <div><i style={`width:${entryUnits / 100}%`}></i></div>
    </div>
  </aside>
</div>
