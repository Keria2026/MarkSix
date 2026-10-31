<script lang="ts">
  import { dragLabel } from "./lib/drag";
  import { entryModeFor } from "./lib/features";
  import type { ModuleFeatures, EntryMode } from "./lib/types";
  import { site } from "./lib/site";
  import { onMount, onDestroy, tick } from "svelte";
  import {
    glassNavigation,
    pageFade,
    reserveNavigationSpace,
  } from "./lib/navigation";
  import {
    LayoutDashboard,
    Plus,
    History,
    Settings2,
    ArrowRight,
    ArrowUpRight,
    ArrowDownLeft,
    ChevronLeft,
    ChevronRight,
    ChevronDown,
    RefreshCw,
    ClipboardPaste,
    LogOut,
    Wallet,
    Coins,
    Activity,
    Layers3,
    Clock3,
    Check,
    CheckCircle2,
    AlertCircle,
    LoaderCircle,
    Search,
    ReceiptText,
    Trash2,
    CalendarDays,
    ArrowLeft,
    X,
  } from "lucide-svelte";
  import type { LicenseStatus } from "./components/Activation.svelte";
  import BatchEditor from "./components/BatchEditor.svelte";
  import PlayOrder from "./components/PlayOrder.svelte";
  import PasswordChange from "./components/PasswordChange.svelte";
  import RecordsTable from "./components/RecordsTable.svelte";
  import SystemSettings from "./components/SystemSettings.svelte";
  import PlayEditor from "./components/PlayEditor.svelte";
  import SlipComposer from "./components/SlipComposer.svelte";
  import SlipDetail from "./components/SlipDetail.svelte";
  import BetEntry from "./components/BetEntry.svelte";
  import TextEntry from "./components/TextEntry.svelte";
  import { newTextDraft } from "./lib/text-entry";
  import StatisticsPanel from "./components/Statistics.svelte";
  import DrawPanel from "./components/DrawPanel.svelte";
  import Modal from "./components/Modal.svelte";
  import {
    money,
    marketName,
    signed,
    time,
    label,
    kinds,
    scopes,
    conditions,
    phases,
  } from "./lib/types";
  import type {
    Bootstrap,
    BetDraft,
    RecordGroup,
    SlipDraftLine,
    BusinessDay,
    Play,
    Bet,
    Page,
    Detail,
    Rule,
    Statistics,
    Layoff,
  } from "./lib/types";

  import { createRequestScope } from "./lib/requests";

  let {
    username,
    licenseStatus,
    onlogout,
    oninvalid,
    onrefreshlicense,
  }: {
    username: string;
    licenseStatus: LicenseStatus;
    onlogout: () => Promise<void>;
    oninvalid: (status: number) => void;
    onrefreshlicense: () => Promise<boolean>;
  } = $props();
  const requests = createRequestScope((status) => oninvalid(status));
  const api = requests.api;
  onDestroy(requests.dispose);

  type Tab = "overview" | "bet" | "history" | "settings" | "statistics";
  let tab = $state<Tab>("overview");
  let boot = $state<Bootstrap | null>(null);
  let entryMode = $state<EntryMode>("manual");
  let entryModeSaving = $state(false);
  const features = $derived(boot?.features);
  const canEnter = $derived(
    !!features && (features.manual_entry || features.text_entry),
  );
  const layoffsEnabled = $derived(features?.layoffs === true);
  function applyFeatures(value: ModuleFeatures) {
    if (!boot) return;
    boot.features = value;
    const mode = entryModeFor(value);
    if (mode) entryMode = mode;
    else if (tab === "bet") tab = "overview";
    if (!value.layoffs) {
      if (statisticsCategory === "receivers") statisticsCategory = "all";
      if (historyCategory === "receivers") historyCategory = "all";
      if (mutationMode === "layoffs") mutationTarget = null;
      flyCancel = null;
    }
  }
  async function selectEntryMode(mode: EntryMode) {
    if (
      entryModeSaving ||
      !features ||
      (mode === "manual" ? !features.manual_entry : !features.text_entry)
    )
      return;
    const previous = entryMode;
    entryMode = mode;
    entryModeSaving = true;
    try {
      applyFeatures(
        await api<ModuleFeatures>("/settings/entry-mode", {
          method: "PUT",
          body: JSON.stringify({ entry_mode: mode }),
        }),
      );
    } catch (e) {
      entryMode = previous;
      notify(fail(e));
    } finally {
      entryModeSaving = false;
    }
  }
  let clipboardRequest = $state(0);
  let textDraft = $state(newTextDraft());
  let betDraft = $state<BetDraft>({
    drag: null,
    packageMode: false,
    playId: 0,
    selections: [],
    compound: false,
    amount: "100",
    bettor: "",
    playSearch: "",
    pickerExpanded: false,
    pendingSubmission: null,
  });
  let busy = $state(false),
    refreshing = $state(false);
  let globalError = $state("");
  let toast = $state("");
  let toastTimer: ReturnType<typeof setTimeout>;
  let records = $state<Page<RecordGroup>>({
    items: [],
    total: 0,
    page: 1,
    page_size: 25,
  });
  let minAmount = $state("");
  let maxAmount = $state("");
  let report = $state<Statistics | null>(null);
  let historyTabs = $state<BusinessDay[]>([]);
  let submenuExpanded = $state({
    statistics: false,
    history: false,
  });
  function loadNavigationPreferences() {
    submenuExpanded = { statistics: false, history: false };
    try {
      const saved = JSON.parse(
        localStorage.getItem(`marksix:menus:${encodeURIComponent(username)}`) ??
          "{}",
      );
      for (const key of ["statistics", "history"] as const)
        if (typeof saved[key] === "boolean") submenuExpanded[key] = saved[key];
    } catch {
      /* Storage can be unavailable in private browsers. */
    }
  }
  function toggleSubmenu(id: Tab) {
    const key = id as keyof typeof submenuExpanded;
    submenuExpanded[key] = !submenuExpanded[key];
    try {
      localStorage.setItem(
        `marksix:menus:${encodeURIComponent(username)}`,
        JSON.stringify(submenuExpanded),
      );
    } catch {
      /* Keep this session's choice. */
    }
  }
  function menuIsOpen(id: Tab) {
    return !!submenuExpanded[id as keyof typeof submenuExpanded];
  }
  function hasSubmenu(id: Tab) {
    return id === "statistics" || (id === "history" && historyTabs.length > 0);
  }
  async function closeHistoryTab(id: string) {
    const index = historyTabs.findIndex((p) => p.id === id);
    historyTabs = historyTabs.filter((p) => p.id !== id);
    const wasActive = tab === "history" && selectedDay?.id === id;
    if (wasActive) {
      const next = historyTabs[Math.min(index, historyTabs.length - 1)];
      if (next) await openDay(next);
      else await navigate("history");
    }
    if (!wasActive) return;
    await tick();
    const target = selectedDay
      ? document.getElementById(`history-period-${selectedDay.id}`)
      : document.querySelector<HTMLButtonElement>(
          'nav .nav-link[aria-label="历史统计"]',
        );
    target?.focus({ preventScroll: true });
  }
  let historyCategory = $state<"all" | "bettors" | "receivers">("all");
  let statisticsCategory = $state<"all" | "bettors" | "receivers" | "records">(
    "all",
  );
  let selectedBettors = $state<string[]>([]);
  let selectedPlays = $state<number[]>([]);
  let recordOrder = $state("newest");
  let recordChoices = $state<{
    period: string;
    bettors: string[];
    plays: { id: number; name: string }[];
  }>({ period: "", bettors: [], plays: [] });
  let parties = $state<{ bettors: string[]; receivers: string[] }>({
    bettors: [],
    receivers: [],
  });
  let mutationTarget = $state<Bet | null>(null);
  let mutationMode = $state<"amount" | "layoffs">("amount");
  let mutationAmount = $state("");
  let receiver = $state("");
  let mutationError = $state("");
  let flyCancel = $state<Layoff | null>(null);
  let pendingMutation: { key: string; id: string } | null = null;
  let selectedDay = $state<BusinessDay | null>(null);
  let history = $state<Page<BusinessDay>>({
      items: [],
      total: 0,
      page: 1,
      page_size: 20,
    }),
    search = $state("");
  let detail = $state<Detail | null>(null),
    detailPage = $state(1),
    cancelTarget = $state<Bet | null>(null);
  let editor = $state(false);
  let editingPlay = $state<Play | null>(null);
  function openEditor(play?: Play) {
    editingPlay = play ? structuredClone($state.snapshot(play)) : null;
    editor = true;
  }
  let settingsSection = $state<"plays" | "system">("plays");
  let settingsSearch = $state("");
  let selectedPlayIds = $state<number[]>([]);
  let batchOpen = $state<"update" | "delete" | null>(null);
  let batchTargets = $state<{ id: number; version: number }[]>([]);
  const settingsPlays = $derived(
    boot?.plays.filter((p) =>
      p.rule.name
        .toLocaleLowerCase()
        .includes(settingsSearch.trim().toLocaleLowerCase()),
    ) ?? [],
  );
  const selectedConfigurations = $derived(
    boot?.plays.filter((p) => selectedPlayIds.includes(p.id)) ?? [],
  );
  function openBatch(action: "update" | "delete") {
    batchTargets = selectedConfigurations.map((p) => ({
      id: p.id,
      version: p.version,
    }));
    batchOpen = action;
  }

  let deletePlayTarget = $state<Play | null>(null);
  let importFile = $state<{
    format: string;
    schema: number;
    plays: { rule: Rule; enabled: boolean }[];
  } | null>(null);
  let importError = $state("");
  let importInput = $state<HTMLInputElement>();
  let currentTime = $state(Date.now());
  let serverOffset = 0;
  const today = $derived(boot?.today ?? null);
  const editablePeriod = (id: string) =>
    [boot?.today, boot?.hk].some((p) => p?.id === id && p.accepting_entries);
  const active = $derived(selectedDay ?? boot?.day ?? null);
  const nav = [
    {
      id: "overview" as Tab,
      label: "本期概览",
      short: "概览",
      icon: LayoutDashboard,
    },
    { id: "bet" as Tab, label: "录入投注", short: "投注", icon: ReceiptText },
    {
      id: "statistics" as Tab,
      label: "本期统计",
      short: "统计",
      icon: Activity,
    },
    { id: "history" as Tab, label: "历史统计", short: "历史", icon: History },
    {
      id: "settings" as Tab,
      label: "玩法与配置",
      short: "配置",
      icon: Settings2,
    },
  ];
  const serverClock = $derived(
    new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date(currentTime)),
  );
  function notify(message: string) {
    if (!message) return;
    toast = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ""), 4000);
  }
  function fail(error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") return "";
    return error instanceof Error ? error.message : "操作失败，请重试";
  }
  let slipItems = $state<SlipDraftLine[]>([]);
  let slipBusy = $state(false);
  let slipPeriod = $state("");
  let slipPending = $state<{ key: string; id: string } | null>(null);
  let slipDetail = $state<RecordGroup | null>(null);
  async function showRecord(record: RecordGroup) {
    if (!record.grouped) return showDetail(record.items[0]);
    try {
      slipDetail = await api(`/slips/${record.id}`);
    } catch (e) {
      notify(fail(e));
    }
  }
  function addSlipItem(line: SlipDraftLine) {
    if (!today) return false;
    if (slipBusy) {
      notify("组合单正在提交，请稍后操作");
      return false;
    }
    if (slipItems.length && slipPeriod !== today.id) {
      notify("组合单草稿已跨期，请清空后重新录入");
      return false;
    }
    if (
      slipItems.length >= 100 ||
      slipItems.reduce((n, item) => n + item.units, 0) + line.units > 1000
    ) {
      notify("组合单最多 100 个分项、1000 条基础注");
      return false;
    }
    if (!slipItems.length) slipPeriod = today.id;
    slipItems = [...slipItems, line];
    notify("已加入组合单，尚未入账");
    return true;
  }
  let recordsRequest = 0;
  let statisticsRequest = 0;
  async function loadRecords(page = 1) {
    if (!active) return;
    const id = active.id;
    const request = ++recordsRequest;
    const query = {
      period: id,
      combined: true,
      page,
      order: recordOrder,
      min_amount: minAmount || null,
      max_amount: maxAmount || null,
      bettors: selectedBettors,
      play_ids: selectedPlays,
    };
    const next = await api<Page<RecordGroup>>("/records/search", {
      method: "POST",
      body: JSON.stringify(query),
    });
    const choices = await api<typeof recordChoices>(
      `/periods/${id}/bet-filters?combined=true`,
    );
    if (request === recordsRequest && active?.id === id) {
      records = next;
      recordChoices = choices;
    }
  }
  async function refresh(silent = false) {
    if (refreshing) return;
    refreshing = true;
    try {
      if (!(await onrefreshlicense())) return;
      const data = await api<Bootstrap>("/bootstrap");
      if (!selectedDay && boot && data.today.id !== boot.today.id) {
        selectedBettors = [];
        selectedPlays = [];
        records.page = 1;
      }
      boot = data;
      if (!entryModeSaving) applyFeatures(data.features);
      serverOffset = new Date(data.today.server_time).getTime() - Date.now();
      if (selectedDay) {
        const id = selectedDay.id;
        const updated = await api<BusinessDay>(`/days/${id}`);
        if (selectedDay?.id === id) selectedDay = updated;
      }
      if (
        tab === "overview" ||
        tab === "bet" ||
        (tab === "statistics" && statisticsCategory === "records") ||
        (tab === "history" && selectedDay)
      )
        await loadRecords(records.page);
      if (active)
        await loadStatistics(
          report?.period === active.id ? report.layoffs_page : 1,
        );
      if (!parties.bettors.length && !parties.receivers.length)
        parties = await api("/parties");
      if (slipDetail) slipDetail = await api(`/slips/${slipDetail.id}`);
      globalError = "";
    } catch (e) {
      globalError = fail(e);
      if (!silent) notify(globalError);
    } finally {
      refreshing = false;
    }
  }
  async function loadStatistics(page = 1) {
    if (!active) return;
    const id = active.id;
    const request = ++statisticsRequest;
    try {
      const next = await api<Statistics>(
        `/periods/${id}/statistics?page=${page}&combined=true`,
      );
      if (active?.id === id && request === statisticsRequest) report = next;
    } catch (e) {
      notify(fail(e));
    }
  }
  async function loadHistory(page = 1) {
    history = await api(
      `/days?page=${page}&search=${encodeURIComponent(search)}`,
    );
  }
  async function navigate(next: Tab) {
    tab = next;
    selectedDay = null;
    selectedBettors = [];
    selectedPlays = [];
    recordOrder = "newest";
    minAmount = "";
    maxAmount = "";
    globalError = "";
    try {
      if (next === "history") await loadHistory();
      else if (next !== "settings") {
        await loadRecords();
        if (active) await loadStatistics();
      }
    } catch (e) {
      globalError = fail(e);
    }
  }
  async function openDay(period: BusinessDay) {
    if (!historyTabs.some((p) => p.id === period.id))
      historyTabs = [...historyTabs, period];
    selectedDay = period;
    selectedBettors = [];
    selectedPlays = [];
    recordOrder = "newest";
    tab = "history";
    report = null;
    minAmount = "";
    maxAmount = "";
    try {
      await loadRecords();
      await loadStatistics();
    } catch (e) {
      globalError = fail(e);
    }
  }
  const signOut = () => onlogout();
  let orderOpen = $state(false);
  async function exportPlays(id?: number) {
    try {
      const file = await api(`/plays/export${id ? `?id=${id}` : ""}`);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `MarkSix-玩法${id ? `-${id}` : ""}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      notify(fail(e));
    }
  }
  async function readImport(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    (event.target as HTMLInputElement).value = "";
    if (!file) return;
    importError = "";
    try {
      if (file.size > 1024 * 1024) throw new Error("玩法文件不能超过 1 MB");
      const parsed = JSON.parse(await file.text());
      if (
        parsed.format !== "marksix-play-rules" ||
        parsed.schema !== 1 ||
        !Array.isArray(parsed.plays) ||
        !parsed.plays.length ||
        parsed.plays.length > 1000
      )
        throw new Error("请选择包含 1–1000 条玩法的 MarkSix 玩法文件");
      if (
        parsed.plays.some(
          (p: { rule?: Rule }) => !p?.rule || typeof p.rule.name !== "string",
        )
      )
        throw new Error("玩法文件内容不完整");
      importFile = parsed;
    } catch (e) {
      notify(fail(e));
    }
  }
  async function confirmImport() {
    if (!importFile) return;
    busy = true;
    try {
      const result = await api<{
        imported: number;
        created: number;
        updated: number;
      }>("/plays/import", {
        method: "POST",
        body: JSON.stringify(importFile),
      });
      importFile = null;
      selectedPlayIds = [];
      notify(`已新增 ${result.created} 条、更新 ${result.updated} 条同名玩法`);
      await refresh();
    } catch (e) {
      importError = fail(e);
    } finally {
      busy = false;
    }
  }
  async function removePlay() {
    if (!deletePlayTarget) return;
    busy = true;
    try {
      await api(`/plays/${deletePlayTarget.id}`, {
        method: "DELETE",
        body: JSON.stringify({ version: deletePlayTarget.version }),
      });
      deletePlayTarget = null;
      editor = false;
      notify("玩法已删除，历史投注保留");
      await refresh();
    } catch (e) {
      notify(fail(e));
    } finally {
      busy = false;
    }
  }
  async function showDetail(bet: Bet) {
    try {
      detail = await api(`/bets/${bet.id}`);
      detailPage = 1;
    } catch (e) {
      notify(fail(e));
    }
  }
  async function cancelBet() {
    if (!cancelTarget) return;
    busy = true;
    try {
      await api(`/bets/${cancelTarget.id}/cancel`, {
        method: "POST",
        body: "{}",
      });
      cancelTarget = null;
      detail = null;
      notify("整条投注已撤销");
      await refresh();
    } catch (e) {
      notify(fail(e));
    } finally {
      busy = false;
    }
  }
  function openMutation(bet: Bet, mode: "amount" | "layoffs") {
    mutationTarget = bet;
    mutationMode = mode;
    mutationAmount = mode === "amount" ? String(bet.amount / 100) : "";
    receiver = "";
    mutationError = "";
    pendingMutation = null;
    detail = null;
  }
  async function saveMutation(event: SubmitEvent) {
    event.preventDefault();
    if (!mutationTarget) return;
    const payload = {
      revision: mutationTarget.revision,
      amount: mutationAmount,
      receiver: mutationMode === "layoffs" ? receiver.trim() : null,
    };
    const key = JSON.stringify({
      id: mutationTarget.id,
      mode: mutationMode,
      payload,
    });
    if (!pendingMutation || pendingMutation.key !== key)
      pendingMutation = { key, id: crypto.randomUUID() };
    busy = true;
    mutationError = "";
    try {
      const bet = mutationTarget;
      await api(`/bets/${bet.id}/${mutationMode}`, {
        method: mutationMode === "amount" ? "PUT" : "POST",
        body: JSON.stringify({ ...payload, request_id: pendingMutation.id }),
      });
      mutationTarget = null;
      pendingMutation = null;
      parties = await api("/parties");
      notify(
        mutationMode === "amount"
          ? "金额已更新，修改记录已保存"
          : "飞出已记录，原受注金额保持不变",
      );
      await refresh();
      await showDetail(bet);
    } catch (e) {
      mutationError = fail(e);
    } finally {
      busy = false;
    }
  }
  async function cancelFly() {
    if (!flyCancel) return;
    busy = true;
    try {
      await api(`/layoffs/${flyCancel.id}/cancel`, {
        method: "POST",
        body: "{}",
      });
      flyCancel = null;
      detail = null;
      await refresh();
      notify("飞出记录已作废");
    } catch (e) {
      notify(fail(e));
    } finally {
      busy = false;
    }
  }
  async function filterBettor(name: string) {
    selectedBettors = [name === "未登记（旧记录）" ? "" : name];
    await loadRecords();
  }
  onMount(() => {
    loadNavigationPreferences();
    void refresh();
    const poll = setInterval(() => {
      if (!document.hidden) void refresh(true);
    }, 6000);
    const clock = setInterval(
      () => (currentTime = Date.now() + serverOffset),
      1000,
    );
    return () => {
      clearInterval(poll);
      clearInterval(clock);
      clearTimeout(toastTimer);
    };
  });
</script>

<svelte:head
  ><title>{nav.find((n) => n.id === tab)?.label} · MarkSix</title></svelte:head
>
<div class="app-shell">
  <aside class="sidebar glass" use:reserveNavigationSpace>
    <a
      class="brand"
      href="#overview"
      onclick={(e) => {
        e.preventDefault();
        void navigate("overview");
      }}
      ><div class="brand-mark">M</div>
      <span>MarkSix<span class="brand-dot">.</span></span></a
    >
    <nav aria-label="主要导航" use:glassNavigation={tab}>
      <div class="nav-indicator" aria-hidden="true"></div>
      {#each nav.filter((item) => item.id !== "bet" || canEnter) as item (item.id)}<div
          class="nav-item"
          class:nav-group-start={item.id === "statistics" ||
            item.id === "settings"}
        >
          <button
            class="nav-link"
            class:active={tab === item.id}
            aria-label={item.label}
            aria-current={tab === item.id ? "page" : undefined}
            aria-expanded={hasSubmenu(item.id)
              ? menuIsOpen(item.id)
              : undefined}
            aria-controls={hasSubmenu(item.id)
              ? `submenu-${item.id}`
              : undefined}
            onclick={() => {
              if (
                tab === item.id &&
                hasSubmenu(item.id) &&
                !(item.id === "history" && selectedDay)
              )
                toggleSubmenu(item.id);
              else void navigate(item.id);
            }}
            ><item.icon size={19} strokeWidth={1.7} /><span class="nav-label"
              >{item.label}</span
            ><span class="nav-label-short" aria-hidden="true">{item.short}</span
            >{#if hasSubmenu(item.id)}<ChevronDown
                size={12}
                class={`nav-caret ${menuIsOpen(item.id) ? "expanded" : ""}`}
              />{/if}</button
          >
          {#if hasSubmenu(item.id)}
            <button
              class="nav-toggle icon-button"
              aria-label={`${menuIsOpen(item.id) ? "收起" : "展开"}${item.label}二级菜单`}
              aria-expanded={menuIsOpen(item.id)}
              aria-controls={`submenu-${item.id}`}
              onclick={() => toggleSubmenu(item.id)}
            >
              <ChevronDown
                size={15}
                class={menuIsOpen(item.id) ? "expanded" : ""}
              />
            </button>
          {/if}
          {#if item.id === "statistics" && submenuExpanded.statistics}<div
              class="nav-submenu"
              id="submenu-statistics"
              aria-label="本期统计分类"
            >
              {#each [{ id: "all", label: "全部受注统计" }, { id: "receivers", label: "飞出受注统计" }, { id: "bettors", label: "投注人分类统计" }, { id: "records", label: "投注记录" }].filter((item) => item.id !== "receivers" || layoffsEnabled) as sub (sub.id)}<button
                  class:active={tab === "statistics" &&
                    statisticsCategory === sub.id}
                  aria-current={tab === "statistics" &&
                  statisticsCategory === sub.id
                    ? "location"
                    : undefined}
                  onclick={() => {
                    statisticsCategory = sub.id as typeof statisticsCategory;
                    if (tab !== "statistics") void navigate("statistics");
                    else if (sub.id === "records")
                      void loadRecords(1).catch((e) => notify(fail(e)));
                  }}>{sub.label}</button
                >{/each}
            </div>{/if}
          {#if item.id === "history" && historyTabs.length && submenuExpanded.history}<div
              class="nav-submenu history-tabs"
              id="submenu-history"
              aria-label="已打开的历史日期"
            >
              {#each historyTabs as period (period.id)}
                <div
                  class="history-tab"
                  class:active={selectedDay?.id === period.id}
                >
                  <button
                    class:active={selectedDay?.id === period.id}
                    aria-current={selectedDay?.id === period.id
                      ? "location"
                      : undefined}
                    id={`history-period-${period.id}`}
                    onclick={() => openDay(period)}
                    >{period.business_date}</button
                  >
                  <button
                    class="history-tab-close"
                    aria-label={`关闭 ${period.business_date} 标签`}
                    onclick={() => closeHistoryTab(period.id)}
                    ><X size={14} /></button
                  >
                </div>
              {/each}
            </div>{/if}
        </div>{/each}
    </nav>
    <div class="sidebar-bottom">
      <div class="account">
        <span class="avatar">A</span>
        <div><strong>{username}</strong><small>管理员</small></div>
        <button
          class="icon-button"
          aria-label="退出登录"
          title="退出登录"
          onclick={signOut}><LogOut size={17} /></button
        >
      </div>
      <span class="version"
        >MARKSIX <span title={site.commit}>{site.version}</span></span
      >
    </div>
  </aside>
  <main
    class="main-content"
    id="main"
    use:pageFade={`${tab}:${selectedDay?.id ?? ""}:${statisticsCategory}:${historyCategory}`}
  >
    <header class="topbar">
      <div class="breadcrumb">
        工作台 <ChevronRight size={13} /><span
          >{nav.find((n) => n.id === tab)?.label}</span
        >
      </div>
      <div class="topbar-right">
        <span class="connection"
          ><i></i>{globalError ? "连接异常" : "已连接"}</span
        ><span class="top-clock"
          ><Clock3 size={14} />{serverClock}<small>北京</small></span
        >{#if features?.text_entry}<button
            class="icon-button"
            aria-label="读取剪切板投注"
            title="读取剪切板投注"
            onclick={() => clipboardRequest++}
            ><ClipboardPaste size={17} /></button
          >{/if}
        <button
          class="icon-button"
          aria-label="刷新数据"
          title="刷新数据"
          onclick={() => refresh()}
          disabled={refreshing}
          ><RefreshCw size={17} class={refreshing ? "spin" : ""} /></button
        >
      </div>
    </header>
    {#if globalError}<div class="notice error" role="alert">
        <AlertCircle size={18} /><span>{globalError}</span><button
          onclick={() => refresh()}>重试</button
        >
      </div>{/if}
    {#if !today}<div class="empty-panel glass">
        <LoaderCircle class="spin" size={25} />
        <h2>正在加载工作台</h2>
      </div>
    {:else if (tab === "overview" || (tab === "history" && selectedDay)) && active}
      <section class="page-heading">
        <div>
          {#if selectedDay}<button
              class="text-button back-link"
              onclick={() => navigate("history")}
              ><ArrowLeft size={14} /> 返回历史统计</button
            >{/if}
          <h1>
            {selectedDay ? `历史统计 · ${active.business_date}` : "本期概览"}
          </h1>
          <p>
            {active.business_date.replaceAll("-", " / ")}
            <span class="status-badge" data-phase={active.phase}
              ><i></i>{phases[active.phase] ?? active.phase}</span
            >
          </p>
        </div>
        {#if canEnter}
          <button class="button primary" onclick={() => navigate("bet")}
            ><Plus size={17} /> 录入投注</button
          >{/if}
      </section>
      <div class="stats-grid">
        <article class="stat glass">
          <div class="stat-label">
            有效投注本金<span class="stat-icon blue-tone"
              ><Wallet size={17} /></span
            >
          </div>
          <strong class="stat-value">{money(active.totals.stake)}</strong>
        </article>
        <article class="stat glass">
          <div class="stat-label">
            {active.state === "settled" ? "总反水" : "预计总反水"}<span
              class="stat-icon purple-tone"><Coins size={17} /></span
            >
          </div>
          <strong class="stat-value">{money(active.totals.rebate)}</strong>
        </article>
        <article class="stat glass">
          <div class="stat-label">
            中奖总返还<span class="stat-icon green-tone"
              ><ArrowUpRight size={17} /></span
            >
          </div>
          <strong class="stat-value"
            >{active.state === "settled"
              ? money(active.totals.payout)
              : "待结算"}</strong
          >
        </article>
        <article class="stat glass">
          <div class="stat-label">
            {layoffsEnabled ? "自留净盈亏" : "原受注净盈亏"}<span
              class="stat-icon coral-tone"><ArrowDownLeft size={17} /></span
            >
          </div>
          <strong
            class="stat-value"
            class:negative={((layoffsEnabled
              ? active.totals.retained_net
              : active.totals.net) ?? 0) < 0}
            class:positive={((layoffsEnabled
              ? active.totals.retained_net
              : active.totals.net) ?? 0) > 0}
          >
            {active.state === "settled"
              ? signed(
                  layoffsEnabled
                    ? active.totals.retained_net
                    : active.totals.net,
                )
              : "待结算"}
          </strong>
        </article>
      </div>
      <div class="draw-grid">
        {#each active.periods as period (period.id)}
          <DrawPanel
            {period}
            market={period.market ?? "macau"}
            mapping={today.mapping}
          />
        {/each}
        {#if !active.periods.some((p) => p.market === "hk")}
          <DrawPanel
            period={selectedDay ? undefined : (boot?.hk ?? undefined)}
            market="hk"
            mapping={today.mapping}
          />
        {/if}
      </div>
      {#if selectedDay}<div
          class="segmented history-categories"
          aria-label="历史统计分类"
        >
          <button
            class:active={historyCategory === "all"}
            onclick={() => (historyCategory = "all")}>全部受注统计</button
          >
          <button
            class:active={historyCategory === "bettors"}
            onclick={() => (historyCategory = "bettors")}>投注人分类统计</button
          >
          {#if layoffsEnabled}
            <button
              class:active={historyCategory === "receivers"}
              onclick={() => (historyCategory = "receivers")}
              >飞出受注统计</button
            >{/if}
        </div>{/if}
      {#if report && report.period === active.id}<StatisticsPanel
          {layoffsEnabled}
          {report}
          {api}
          compact={!selectedDay}
          category={selectedDay ? historyCategory : "bettors"}
          onbettor={filterBettor}
          onpage={loadStatistics}
        />{/if}
      <RecordsTable
        {records}
        {recordChoices}
        historical={!!selectedDay}
        bind:selectedBettors
        bind:selectedPlays
        bind:minAmount
        bind:maxAmount
        bind:recordOrder
        onload={async (page = 1) => {
          try {
            await loadRecords(page);
          } catch (e) {
            notify(fail(e));
          }
        }}
        showDetail={showRecord}
        {canEnter}
        onbet={() => navigate("bet")}
      />
    {:else if tab === "bet" && canEnter}
      <section class="page-heading">
        <div>
          <h1>录入投注</h1>
          <p>港澳投注统一录入</p>
        </div>
        <button class="button secondary" onclick={() => navigate("overview")}
          ><LayoutDashboard size={16} /> 本期概览</button
        >
      </section>
      <div class="segmented entry-mode" aria-label="录注方式">
        {#if features?.manual_entry}<button
            class:active={entryMode === "manual"}
            aria-pressed={entryMode === "manual"}
            disabled={entryModeSaving}
            onclick={() => selectEntryMode("manual")}>手工录注</button
          >{/if}
        {#if features?.text_entry}<button
            class:active={entryMode === "text"}
            aria-pressed={entryMode === "text"}
            disabled={entryModeSaving}
            onclick={() => selectEntryMode("text")}>文本录注</button
          >{/if}
      </div>
      {#if entryMode !== "text"}
        <BetEntry
          boot={boot!}
          {today}
          bind:draft={betDraft}
          {api}
          {notify}
          onrecorded={() => refresh()}
          onconfigure={() => navigate("settings")}
          onadd={addSlipItem}
        />
        <SlipComposer
          bind:items={slipItems}
          bind:busy={slipBusy}
          bind:pending={slipPending}
          period={slipPeriod}
          bettor={betDraft.bettor}
          {today}
          {api}
          onrecorded={async () => {
            await refresh();
            notify("组合单已完整入账");
          }}
        />
      {/if}
    {:else if tab === "history"}
      <section class="page-heading">
        <div>
          <h1>历史统计</h1>
        </div>
        <span class="heading-icon glass"><History size={24} /></span>
      </section>
      <section class="glass history-panel">
        <div class="section-head">
          <h2>历史日期 <span class="count-badge">{history.total}</span></h2>
          <form
            class="search-box"
            onsubmit={(e) => {
              e.preventDefault();
              void loadHistory().catch((e) => notify(fail(e)));
            }}
          >
            <Search size={16} /><input
              aria-label="搜索期号或日期"
              bind:value={search}
              placeholder="搜索期号或日期"
            /><button type="submit">查询</button>
          </form>
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
                ><th>录入业务日期</th><th>状态</th><th>有效本金</th><th
                  >中奖返还</th
                ><th>反水</th><th>盘口净盈利</th><th>操作</th></tr
              ></thead
            ><tbody
              >{#each history.items as p}<tr
                  ><td><strong>{p.business_date}</strong></td><td
                    ><span class="status-badge" data-phase={p.phase}
                      >{phases[p.phase]}</span
                    ></td
                  ><td>{money(p.totals.stake)}</td><td
                    >{p.state === "settled"
                      ? money(p.totals.payout)
                      : "待结算"}</td
                  ><td>{money(p.totals.rebate)}</td><td
                    class:positive={(p.totals.net ?? 0) > 0}
                    class:negative={(p.totals.net ?? 0) < 0}
                    ><strong
                      >{p.state === "settled"
                        ? signed(p.totals.net)
                        : "待结算"}</strong
                    ></td
                  ><td
                    ><button class="text-button" onclick={() => openDay(p)}
                      >查看 <ArrowRight size={14} /></button
                    ></td
                  ></tr
                >{/each}</tbody
            >
          </table>
          {#if !history.items.length}<div class="empty-state">
              <CalendarDays size={30} />
              <h3>还没有匹配的日期</h3>
              <p>试试其他期号或业务日期。</p>
            </div>{/if}
        </div>
        <div class="table-footer">
          <span>共 {history.total} 天</span>
          <div class="pagination">
            <button
              class="icon-button"
              aria-label="上一页历史"
              disabled={history.page === 1}
              onclick={() =>
                loadHistory(history.page - 1).catch((e) => notify(fail(e)))}
              ><ChevronLeft size={16} /></button
            ><span>{history.page}</span><button
              class="icon-button"
              aria-label="下一页历史"
              disabled={history.page * 20 >= history.total}
              onclick={() =>
                loadHistory(history.page + 1).catch((e) => notify(fail(e)))}
              ><ChevronRight size={16} /></button
            >
          </div>
        </div>
      </section>
    {:else if tab === "statistics"}
      <section class="page-heading">
        <div>
          <h1>本期统计</h1>
          <p>
            <strong>{active?.business_date ?? today.business_date}</strong> · {statisticsCategory ===
            "receivers"
              ? "飞出受注统计"
              : statisticsCategory === "bettors"
                ? "投注人分类统计"
                : statisticsCategory === "records"
                  ? "投注记录"
                  : "全部受注统计"}
          </p>
        </div>
      </section>
      {#if statisticsCategory === "records"}
        <RecordsTable
          {records}
          {recordChoices}
          historical={!!selectedDay}
          bind:selectedBettors
          bind:selectedPlays
          bind:minAmount
          bind:maxAmount
          bind:recordOrder
          onload={async (page = 1) => {
            try {
              await loadRecords(page);
            } catch (e) {
              notify(fail(e));
            }
          }}
          showDetail={showRecord}
          {canEnter}
          onbet={() => navigate("bet")}
        />
      {:else if report && report.period === active?.id}<StatisticsPanel
          {layoffsEnabled}
          {report}
          {api}
          category={statisticsCategory}
          onpage={loadStatistics}
        />{:else}<div class="empty-panel glass">正在加载本期统计…</div>{/if}
    {:else if tab === "settings"}
      <section class="page-heading">
        <div>
          <h1>玩法与配置</h1>
        </div>
        {#if settingsSection === "plays"}<div class="configuration-actions">
            <input
              type="file"
              accept=".json,application/json"
              bind:this={importInput}
              onchange={readImport}
              hidden
              aria-label="选择玩法文件"
            />
            <button
              class="button secondary"
              onclick={() => importInput?.click()}>导入玩法</button
            >
            <button
              class="button secondary"
              disabled={!boot?.plays.length}
              onclick={() => exportPlays()}>导出全部</button
            >
            <button class="button primary" onclick={() => openEditor()}
              ><Plus size={17} /> 新建玩法</button
            >
            <button
              class="button secondary"
              disabled={!boot?.plays.length}
              onclick={() => (orderOpen = true)}>排序玩法</button
            >
          </div>{/if}
      </section>
      <section class="glass settings-switcher" aria-label="配置分区">
        <button
          class:active={settingsSection === "plays"}
          aria-pressed={settingsSection === "plays"}
          onclick={() => (settingsSection = "plays")}
          ><Layers3 size={20} /><span>玩法设置</span></button
        ><button
          class:active={settingsSection === "system"}
          aria-pressed={settingsSection === "system"}
          onclick={() => (settingsSection = "system")}
          ><Settings2 size={20} /><span>配置设置</span></button
        >
      </section>
      {#if settingsSection === "plays"}
        <section class="glass plays-panel">
          <div class="section-head">
            <h2>
              玩法配置 <span class="count-badge">{boot?.plays.length ?? 0}</span
              >
            </h2>
          </div>
          <div class="play-management-toolbar">
            <label
              >搜索配置玩法<input
                type="search"
                bind:value={settingsSearch}
                placeholder="按名称查找"
              /></label
            ><label class="checkbox-line"
              ><input
                type="checkbox"
                checked={settingsPlays.length > 0 &&
                  settingsPlays.every((p) => selectedPlayIds.includes(p.id))}
                onchange={(e) =>
                  (selectedPlayIds = e.currentTarget.checked
                    ? [
                        ...new Set([
                          ...selectedPlayIds,
                          ...settingsPlays.map((p) => p.id),
                        ]),
                      ]
                    : selectedPlayIds.filter(
                        (id) => !settingsPlays.some((p) => p.id === id),
                      ))}
              />选择当前结果</label
            ><span>已选 {selectedConfigurations.length} 项</span><button
              class="button secondary"
              disabled={!selectedConfigurations.length}
              onclick={() => openBatch("update")}>批量调整</button
            ><button
              class="button danger"
              disabled={!selectedConfigurations.length}
              onclick={() => openBatch("delete")}>批量删除</button
            ><button class="text-button" onclick={() => (selectedPlayIds = [])}
              >取消选择</button
            >
          </div>
          <div class="play-settings-grid">
            {#each settingsPlays as play}<div
                class="play-management-item"
                class:selected-play={selectedPlayIds.includes(play.id)}
              >
                <button
                  class="play-setting"
                  class:disabled-play={!play.enabled}
                  onclick={() => openEditor(play)}
                  ><div>
                    <span class="play-symbol"><Layers3 size={21} /></span>
                  </div>
                  <h3>
                    {play.rule.name}
                    {#if !play.enabled}<small>已停用</small>{/if}
                  </h3>
                  <p>
                    {kinds[play.rule.kind]} · {scopes[play.rule.scope]} · {conditions[
                      play.rule.condition
                    ]}
                  </p>
                  <div class="play-rate">
                    <span
                      >含本赔率<strong>{play.rule.odds}<small>×</small></strong
                      ></span
                    ><span
                      >反水<strong
                        >{play.rule.rebate_percent}<small>%</small></strong
                      ></span
                    ><span class="edit-link"
                      >编辑 <ArrowUpRight size={15} /></span
                    >
                  </div></button
                >
                <label class="play-select checkbox-line"
                  ><input
                    type="checkbox"
                    aria-label={`选择玩法 ${play.rule.name}`}
                    checked={selectedPlayIds.includes(play.id)}
                    onchange={(e) =>
                      (selectedPlayIds = e.currentTarget.checked
                        ? [...selectedPlayIds, play.id]
                        : selectedPlayIds.filter((id) => id !== play.id))}
                  /><span class="play-select-indicator" aria-hidden="true"
                    >{#if selectedPlayIds.includes(play.id)}<Check
                        size={12}
                      />{/if}</span
                  ><span>V{play.version}</span></label
                >
              </div>{/each}
          </div>
        </section>
      {:else}
        <PasswordChange {api} onchanged={onlogout} />
        <SystemSettings
          features={boot!.features}
          onfeatures={applyFeatures}
          {today}
          {licenseStatus}
          {api}
          {notify}
          oncleared={async () => {
            selectedDay = null;
            historyTabs = [];
            detail = null;
            report = null;
            parties = { bettors: [], receivers: [] };
            await refresh();
          }}
        />
      {/if}
    {/if}
    {#if licenseStatus.active && boot && today && features?.text_entry}
      <TextEntry
        bind:draft={textDraft}
        {boot}
        {today}
        {api}
        {notify}
        account={username}
        active={tab === "bet" && entryMode === "text"}
        {clipboardRequest}
        onactivate={() => {
          void navigate("bet");
          void selectEntryMode("text");
        }}
        onrecorded={() => refresh()}
      />
    {/if}
  </main>
</div>

{#if licenseStatus.active}
  {#if slipDetail}<SlipDetail
      {layoffsEnabled}
      record={slipDetail}
      canCancel={slipDetail.items.every((item) =>
        editablePeriod(item.period_id),
      )}
      {api}
      onclose={() => (slipDetail = null)}
      onshow={showDetail}
      onchanged={() => refresh()}
    />{/if}
  {#if orderOpen && boot}<PlayOrder
      plays={boot.plays}
      {api}
      onclose={() => (orderOpen = false)}
      onsaved={async () => {
        orderOpen = false;
        await refresh();
        notify("玩法顺序已保存");
      }}
    />{/if}
  {#if detail}<Modal title="投注记录详情" wide onclose={() => (detail = null)}
      ><div class="detail-heading">
        <div>
          <span class="eyebrow"
            >{marketName(detail.record.market)} · {detail.record.expect
              ? `第 ${detail.record.expect} 期`
              : "待开奖"} · {time(detail.record.created_at)}</span
          >
          <h3>
            {detail.record.rule.name}<span class="soft-chip"
              >V{detail.record.play_version} 快照</span
            >
          </h3>
          <p>
            {scopes[detail.record.rule.scope]} · {conditions[
              detail.record.rule.condition
            ]}
          </p>
        </div>
        <strong>{money(detail.record.stake)}</strong>
      </div>
      {#if detail.record.drag}<p class="drag-summary">
          {dragLabel(detail.record.rule.kind, detail.record.drag)}
        </p>{/if}
      <div class="detail-info">
        <span
          >投注人 <strong>{detail.record.bettor || "未登记（旧记录）"}</strong
          ></span
        >
        <span>基础注 <strong>{detail.atoms.length}</strong></span><span
          >{detail.record.package_zodiacs?.length ? "每肖本金" : "每注本金"}
          <strong>{money(detail.record.amount)}</strong></span
        ><span
          >反水比例 <strong>{detail.record.rule.rebate_percent}%</strong></span
        ><span
          >状态 <strong
            >{detail.record.status === "cancelled"
              ? "已撤销"
              : detail.record.status === "settled"
                ? "已结算"
                : "待结算"}</strong
          ></span
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
              ><th>组合</th><th>本金</th><th>赔率</th><th>结果</th><th
                >含本返还</th
              ><th>反水</th><th>盘口净盈亏</th></tr
            ></thead
          ><tbody
            >{#each detail.atoms.slice((detailPage - 1) * 50, detailPage * 50) as atom, offset}{@const result =
                detail.results?.[(detailPage - 1) * 50 + offset]}<tr
                ><td
                  >{atom.options
                    .map((v) => label(detail!.record.rule.kind, v))
                    .join(" · ")}</td
                ><td>{money(atom.stake)}</td><td
                  >{atom.odds}×{#if atom.special_hit_odds}<small>
                      / 含特 {atom.special_hit_odds}×</small
                    >{/if}</td
                ><td
                  >{result
                    ? result.voided
                      ? "和局退本"
                      : result.won
                        ? "中奖"
                        : "未中奖"
                    : detail.record.status === "cancelled"
                      ? "已撤销"
                      : "待开奖"}</td
                ><td>{result ? money(result.payout) : "—"}</td><td
                  >{detail.record.status === "cancelled"
                    ? "—"
                    : money(result?.rebate ?? atom.rebate)}</td
                ><td
                  class:negative={(result?.net ?? 0) < 0}
                  class:positive={(result?.net ?? 0) > 0}
                  >{result ? signed(result.net) : "—"}</td
                ></tr
              >{/each}</tbody
          >
        </table>
      </div>
      <div class="table-footer">
        <span
          >组合明细 · 第 {detailPage} / {Math.ceil(detail.atoms.length / 50)} 页</span
        >
        <div class="pagination">
          <button
            class="icon-button"
            aria-label="上一页组合"
            disabled={detailPage === 1}
            onclick={() => detailPage--}><ChevronLeft size={16} /></button
          ><button
            class="icon-button"
            aria-label="下一页组合"
            disabled={detailPage * 50 >= detail.atoms.length}
            onclick={() => detailPage++}><ChevronRight size={16} /></button
          >
        </div>
      </div>
      {#if layoffsEnabled && detail.layoffs.length}<section
          class="detail-ledger"
        >
          <h3>关联飞出</h3>
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
                  ><th>受注方</th><th
                    >{detail.record.package_zodiacs?.length
                      ? "每肖金额"
                      : "每注金额"}</th
                  ><th>飞出总额</th><th>状态 / 本方盈亏</th><th>操作</th></tr
                ></thead
              ><tbody
                >{#each detail.layoffs as row}<tr
                    ><td>{row.receiver}</td><td>{money(row.amount)}</td><td
                      >{money(row.stake)}</td
                    ><td
                      >{row.status === "cancelled"
                        ? "已作废"
                        : row.status === "settled"
                          ? signed((row.payout ?? 0) + row.rebate - row.stake)
                          : "待开奖"}</td
                    ><td
                      >{#if row.status !== "cancelled" && editablePeriod(row.period_id)}<button
                          class="text-button"
                          onclick={() => {
                            flyCancel = row;
                            detail = null;
                          }}>撤销飞出</button
                        >{/if}</td
                    ></tr
                  >{/each}</tbody
              >
            </table>
          </div>
        </section>{/if}
      {#if detail.events.length}<details class="audit-details">
          <summary>操作记录（最近 100 条）</summary
          >{#each detail.events.filter((event) => layoffsEnabled || !["bet_flown", "layoff_cancelled"].includes(event.event)) as event}<p
            >
              <time>{time(event.created_at)}</time> · {{
                bet_created: "录入投注",
                bet_cancelled: "作废投注",
                bet_amount_changed: "纠正金额",
                bet_flown: "记录飞出",
                layoff_cancelled: "撤销飞出",
              }[event.event] ??
                event.event}{#if event.event === "bet_amount_changed"}
                · 每注 {money(Number(event.detail.before_amount))} → {money(
                  Number(event.detail.after_amount),
                )}{/if}{#if event.event === "bet_flown"}
                · {String(event.detail.receiver)} · 每注 {money(
                  Number(event.detail.amount),
                )}{/if}
            </p>{/each}
        </details>{/if}
      {#if detail.record.status !== "cancelled" && editablePeriod(detail.record.period_id)}<div
          class="modal-actions"
        >
          <button
            class="button secondary"
            onclick={() => openMutation(detail!.record, "amount")}
            >修改金额</button
          >
          {#if layoffsEnabled}
            <button
              class="button primary"
              onclick={() => openMutation(detail!.record, "layoffs")}
              >飞出</button
            >{/if}
          <button
            class="button danger"
            onclick={() => {
              cancelTarget = detail!.record;
              detail = null;
            }}><Trash2 size={15} /> 撤销整条记录</button
          >
        </div>{/if}</Modal
    >{/if}
  {#if cancelTarget}<Modal
      title="撤销这条投注？"
      onclose={() => (cancelTarget = null)}
      ><p class="modal-description">
        将撤销「{cancelTarget.rule.name}」的全部 {cancelTarget.unit_count} 条基础注，总本金
        {money(cancelTarget.stake)}。原始记录会保留，不再计入有效投注及反水。
      </p>
      <div class="modal-actions">
        <button class="button secondary" onclick={() => (cancelTarget = null)}
          >保留记录</button
        ><button class="button danger" disabled={busy} onclick={cancelBet}
          >确认撤销</button
        >
      </div></Modal
    >{/if}
  {#if mutationTarget}<Modal
      title={mutationMode === "amount" ? "修改投注金额" : "记录飞出"}
      onclose={() => (mutationTarget = null)}
    >
      <form onsubmit={saveMutation} class="rule-form">
        <div class="segmented">
          <button
            type="button"
            class:active={mutationMode === "amount"}
            onclick={() => (mutationMode = "amount")}>纠正原金额</button
          >{#if layoffsEnabled}<button
              type="button"
              class:active={mutationMode === "layoffs"}
              onclick={() => (mutationMode = "layoffs")}>飞出</button
            >{/if}
        </div>
        <p class="modal-description">
          {mutationTarget.bettor || "未登记"} · {mutationTarget.rule.name} · {mutationTarget.unit_count}
          条基础注 · 原{mutationTarget.package_zodiacs?.length
            ? "每肖"
            : "每注"}
          {money(mutationTarget.amount)}
        </p>
        {#if mutationMode === "layoffs"}<label
            >飞出受注方<input
              bind:value={receiver}
              list="receiver-suggestions"
              maxlength="80"
              required
              placeholder="选择已有受注方或手工填写"
            /></label
          >{/if}
        <label
          >{mutationTarget.package_zodiacs?.length
            ? mutationMode === "amount"
              ? "修改后的每肖金额（最多一位小数）"
              : "每肖飞出金额（元）"
            : mutationMode === "amount"
              ? "修改后的每注金额（最多一位小数）"
              : "每条基础注飞出金额（元）"}<input
            bind:value={mutationAmount}
            inputmode="decimal"
            required
          /></label
        >

        {#if mutationError}<div class="inline-error" role="alert">
            {mutationError}
          </div>{/if}
        <div class="modal-actions">
          <button
            type="button"
            class="button secondary"
            onclick={() => (mutationTarget = null)}>取消</button
          ><button class="button primary" disabled={busy}
            >确认{mutationMode === "amount" ? "修改" : "飞出"}</button
          >
        </div>
      </form>
    </Modal>{/if}
  {#if flyCancel}<Modal
      title="撤销这条飞出？"
      onclose={() => (flyCancel = null)}
      ><p class="modal-description">
        受注方 {flyCancel.receiver}，飞出总额 {money(
          flyCancel.stake,
        )}。作废后不再计入飞出统计，原记录仍保留。
      </p>
      <div class="modal-actions">
        <button class="button secondary" onclick={() => (flyCancel = null)}
          >保留记录</button
        ><button class="button danger" disabled={busy} onclick={cancelFly}
          >确认撤销飞出</button
        >
      </div></Modal
    >{/if}
  <datalist id="bettor-suggestions"
    >{#each parties.bettors as name}<option value={name}
      ></option>{/each}</datalist
  >
  <datalist id="receiver-suggestions"
    >{#each parties.receivers as name}<option value={name}
      ></option>{/each}</datalist
  >
  {#if editor}<PlayEditor
      play={editingPlay}
      {api}
      onclose={() => (editor = false)}
      onsaved={async () => {
        notify("玩法已保存");
        await refresh();
      }}
      ondelete={(play) => {
        deletePlayTarget = play;
        editor = false;
      }}
      onexport={exportPlays}
    />{/if}
{/if}
{#if toast}<div class="toast glass" role="status">
    <CheckCircle2 size={18} /><span>{toast}</span><button
      class="icon-button"
      aria-label="关闭提示"
      onclick={() => (toast = "")}><X size={15} /></button
    >
  </div>{/if}

{#if deletePlayTarget && licenseStatus?.active}<Modal
    title="删除玩法？"
    onclose={() => (deletePlayTarget = null)}
  >
    <p class="modal-description">
      删除「{deletePlayTarget.rule
        .name}」后不能再录入新投注。历史投注、规则快照和统计将完整保留。
    </p>
    <div class="modal-actions">
      <button
        class="button secondary"
        disabled={busy}
        onclick={() => (deletePlayTarget = null)}>取消</button
      ><button class="button danger" disabled={busy} onclick={removePlay}
        >确认删除玩法</button
      >
    </div>
  </Modal>{/if}
{#if importFile && licenseStatus?.active}<Modal
    title="导入玩法规则"
    onclose={() => (importFile = null)}
  >
    <p class="modal-description">
      将导入 {importFile.plays.length} 条玩法：同名默认覆盖当前配置，不同名新增。已有投注沿用原规则快照。若现有名称重名，整批拒绝，请先整理重名项。
    </p>
    <ul class="import-preview">
      {#each importFile.plays as item}<li>
          {item.rule.name}<span
            >{item.rule.odds} 倍 · 反水 {item.rule.rebate_percent}% · {item.enabled
              ? "启用"
              : "停用"}</span
          >
        </li>{/each}
    </ul>
    {#if importError}<p class="inline-error" role="alert">{importError}</p>{/if}
    <div class="modal-actions">
      <button
        class="button secondary"
        disabled={busy}
        onclick={() => (importFile = null)}>取消</button
      ><button class="button primary" disabled={busy} onclick={confirmImport}
        >确认导入</button
      >
    </div>
  </Modal>{/if}

{#if batchOpen}<BatchEditor
    action={batchOpen}
    targets={batchTargets}
    {api}
    onclose={() => (batchOpen = null)}
    onsaved={async () => {
      batchOpen = null;
      selectedPlayIds = [];
      await refresh();
      notify("所选玩法已更新");
    }}
  />{/if}
