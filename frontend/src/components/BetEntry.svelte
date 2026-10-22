<script lang="ts">
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
    ShieldCheck,
    Sparkles,
  } from "lucide-svelte";
  import {
    ApiError,
    money,
    entryCents,
    signed,
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
    Quote,
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
  // Abort quote/submission responses when leaving this form as well as logout.
  const requests = createRequestScope(
    () => {},
    (path, options) => accountApi(path, options),
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
      ? today.mapping.zodiac.flatMap((z, i) =>
          values.includes(z) ? [i + 1] : [],
        )
      : values;
    return selectionBoundary(currentPlay.rule, selected, draft.compound);
  }
  function setPackageMode(value: boolean) {
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
  let quote = $state<Quote | null>(null),
    quoteState = $state<"idle" | "loading" | "ready" | "error">("idle"),
    quoteError = $state("");
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
    today.mapping.zodiac.flatMap((z, i) =>
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
  const selectedCount = $derived(
    currentPlay
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
      !textInvalid &&
      selectedCount > 0 &&
      selectedCount <= 1000 &&
      entryCents(draft.amount) !== null,
  );
  const stakePreview = $derived(
    (entryCents(draft.amount) ?? 0n) *
      BigInt(draft.packageMode ? draft.selections.length : selectedCount),
  );
  const quoteKey = $derived(
    inputValid && today && currentPlay
      ? JSON.stringify({
          period: today.id,
          play_id: currentPlay.id,
          play_version: currentPlay.version,
          ...(draft.packageMode
            ? { package_zodiacs: [...draft.selections].sort((a, b) => a - b) }
            : {}),
          selections: draft.packageMode
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
    selectionError = "";
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
    if (!inputValid || !quoteKey || !draft.bettor.trim()) return;
    busy = true;
    const body = JSON.parse(quoteKey);
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
      draft.selections = [];
      syncSelectionText();
      notify(
        today.draw
          ? "投注已记录并按本期开奖结果结算"
          : "投注已记录，正在更新本期风险",
      );
      await onrecorded();
    } catch (e) {
      notify(fail(e));
    } finally {
      busy = false;
    }
  }
  const quoteDraw = $derived(JSON.stringify(today.draw));
  $effect(() => {
    const key = quoteKey;
    const isBetting = today.accepting_entries;
    void quoteDraw;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout>;
    quote = null;
    quoteError = "";
    quoteState = key && isBetting ? "loading" : "idle";
    async function calculate() {
      try {
        const result = await api<Quote>("/quote", {
          method: "POST",
          body: key,
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          quote = result;
          quoteState = "ready";
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof ApiError && e.status === 429) {
          quoteError = "正在等待精确计算，稍后自动重试";
          retry = setTimeout(calculate, 2000);
        } else {
          quoteState = "error";
          quoteError = fail(e);
        }
      }
    }
    const timer = key && isBetting ? setTimeout(calculate, 450) : undefined;
    return () => {
      clearTimeout(timer);
      clearTimeout(retry);
      controller.abort();
    };
  });
  const validAmount = $derived(entryCents(draft.amount) !== null);
</script>

<div class="bet-layout">
  <section class="bet-form glass">
    <div class="section-head">
      <h2><span class="step">01</span> 选择玩法</h2>
      <span class="muted small">规则由管理员配置</span>
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
              class:active={!draft.compound}
              aria-pressed={!draft.compound}
              onclick={() => setCompound(false)}>普通 / 多选</button
            ><button
              class:active={draft.compound}
              aria-pressed={draft.compound}
              onclick={() => setCompound(true)}>复式</button
            >
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
      {#if draft.packageMode}<p class="field-help">
          金额按每肖填写，按当期生肖表平均分配到各号码；余下的分按号码升序分配。各号码分别结算。
        </p>{/if}
      {#if currentPlay.rule.kind === "zodiac_count"}<p class="field-help">
          全部 7 个开奖号码恰好出现 {currentPlay.rule.zodiac_count} 种不同生肖时中奖；同一生肖出现多次只计一种。
        </p>{/if}
      {#if currentPlay.rule.special_hit_odds}<p class="field-help">
          两平码按 {currentPlay.rule.odds} 倍；一特一平按 {currentPlay.rule
            .special_hit_odds} 倍返还。
        </p>{/if}
      {#if currentPlay.rule.condition === "hard_pair"}<p class="field-help">
          按顺序选择：第一个号码必须开在特码，第二个必须开在平码。当前：{draft.selections
            .map((n, i) => `${i === 0 ? "特码" : "平码"} ${label("number", n)}`)
            .join(" → ") || "尚未选择"}
        </p>{/if}
      {#if currentPlay.rule.condition === "at_least"}<p class="field-help">
          每注至少命中 {currentPlay.rule.minimum_hits} 个选项即中奖。
        </p>{/if}
      {#if currentPlay.rule.kind === "size" || currentPlay.rule.kind === "parity"}<p
          class="field-help"
        >
          所选开奖范围出现 49 时，本基础注和局退本，不计有效投注、无反水。
        </p>{/if}
      <div class="selection-description">
        <span
          >{draft.packageMode
            ? "选择生肖，每肖金额独立包号"
            : draft.compound
              ? `从候选项中每 ${currentPlay.rule.combination_size} 个拆成一注`
              : `选择数量${relations[currentPlay.rule.relation]} ${currentPlay.rule.quantity} 个${currentPlay.rule.quantity === 1 ? "；多选逐项拆注" : "；允许的超额选择按阈值拆注"}`}</span
        ><button
          class="text-button"
          onclick={() => {
            draft.selections = [];
            selectionError = "";
            syncSelectionText();
          }}
          disabled={!draft.selections.length && !selectionText}>清空选择</button
        >
      </div>
      <label class="play-search selection-input"
        >输入投注项<input
          type="text"
          maxlength="2048"
          value={selectionText}
          aria-invalid={textInvalid}
          aria-describedby={selectionError
            ? "selection-error"
            : "selection-input-help"}
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
      <p id="selection-input-help" class="field-help">
        支持空格、中英文标点分隔，重复项只计一次；输入与下方选择同步，超过规则边界时不应用、不提交。
      </p>
      <div
        class="option-grid"
        class:number-grid={selectionKind === "number"}
        class:zodiac-grid={selectionKind === "zodiac"}
      >
        {#each options(selectionKind).filter((value) => currentPlay.rule.kind !== "zodiac_count" || value === currentPlay.rule.zodiac_count) as value}<button
            class="option"
            class:selected={draft.selections.includes(value)}
            aria-pressed={draft.selections.includes(value)}
            aria-label={`${label(selectionKind, value)}${selectionKind === "number" ? ` ${zodiacs[today.mapping.zodiac[value - 1]]}` : ""}`}
            onclick={() => toggleOption(value)}
            >{#if selectionKind === "number"}<span
                class="number-option"
                data-wave={wave(value)}>{label(selectionKind, value)}</span
              ><small>{zodiacs[today.mapping.zodiac[value - 1]]}</small
              >{:else}<span>{label(selectionKind, value)}</span
              >{#if selectionKind === "zodiac" && value === today.mapping.natal}<small
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
        {#if currentPlay.rule.zero_tail_odds != null}<span
            >含 0 尾基础注赔率 <strong>{currentPlay.rule.zero_tail_odds}</strong
            > 倍</span
          >{/if}
        <span>已选 <strong>{draft.selections.length}</strong> 项</span
        >{#if currentPlay.rule.special_odds}<span
            >含本命生肖基础注赔率 <strong
              >{currentPlay.rule.special_odds}</strong
            > 倍</span
          >{/if}
      </div>
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
        <span class="eyebrow">BET SUMMARY</span>
        <h2>本次投注</h2>
      </div>
      <ReceiptText size={21} class="muted" />
    </div>
    <div class="summary-name">
      {currentPlay?.rule.name ?? "选择一个玩法"}<span class="soft-chip"
        >{draft.packageMode
          ? "包肖"
          : draft.compound
            ? "复式"
            : selectedCount > 1
              ? "多选"
              : "单注"}</span
      >
    </div>
    <div class="selected-tags">
      {#if draft.selections.length}{#each draft.selections.slice(0, 20) as value}<span
            >{label(selectionKind, value)}</span
          >{/each}{#if draft.selections.length > 20}<span
            >+{draft.selections.length - 20}</span
          >{/if}{:else}<p>选择投注项后，在这里查看汇总。</p>{/if}
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
    <div class="quote-box">
      <div class="quote-label">
        <Sparkles size={15} /><span>投注者收益预览</span
        >{#if quoteState === "loading"}<LoaderCircle
            class="spin"
            size={14}
          />{/if}
      </div>
      <div class="ledger-row">
        <span>{quote?.settled ? "实际含本返还" : "最大含本返还"}</span><strong
          >{money(quote?.max_return)}</strong
        >
      </div>
      <div class="ledger-row">
        <span>{quote?.settled ? "实际反水" : "预计反水"}</span><strong
          >{money(quote?.rebate)}</strong
        >
      </div>
      <div class="ledger-row">
        <span
          >{quote?.settled
            ? "实际净输赢（含反水）"
            : "最大净盈利（含反水）"}</span
        ><strong
          class:positive={(quote?.max_profit ?? 0) > 0}
          class:negative={(quote?.max_profit ?? 0) < 0}
          >{quote ? signed(quote.max_profit) : "—"}</strong
        >
      </div>
      {#if quoteError}<p class:negative={quoteState === "error"}>
          {quoteError}
        </p>{:else}<p>
          {quote?.settled
            ? "按本期已确认开奖结果计算。"
            : "基于同一个合法开奖结果精确计算。"}
        </p>{/if}
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
          play_id: currentPlay.id,
          play_version: currentPlay.version,
          selections: draft.packageMode ? [] : [...draft.selections],
          ...(draft.packageMode
            ? { package_zodiacs: [...draft.selections] }
            : {}),
          compound: draft.compound,
          amount: draft.amount,
          units: selectedCount,
        });
        if (added) {
          draft.selections = [];
          draft.pendingSubmission = null;
          syncSelectionText();
        }
      }}>加入组合单</button
    >
    <p class="summary-note">
      <ShieldCheck size={13} /> 规则与赔率在提交时留存快照
    </p>
    <div class="quota">
      <span>本期容量</span><small
        >{today.totals.units.toLocaleString()} / 10,000 基础注</small
      >
      <div><i style={`width:${today.totals.units / 100}%`}></i></div>
    </div>
  </aside>
</div>
