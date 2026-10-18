<script lang="ts">
  import { site } from "./lib/site";
  import { onMount, onDestroy, tick } from "svelte";
  import { glassNavigation, pageFade } from "./lib/navigation";
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
    ShieldCheck,
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
    Info,
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
  import StatisticsPanel from "./components/Statistics.svelte";
  import Balls from "./components/Balls.svelte";
  import Modal from "./components/Modal.svelte";
  import {
    money,
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
    Period,
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

  type Tab =
    | "overview"
    | "bet"
    | "history"
    | "settings"
    | "statistics"
    | "official";
  let tab = $state<Tab>("overview");
  let boot = $state<Bootstrap | null>(null);
  let betDraft = $state<BetDraft>({
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
  let historyTabs = $state<Period[]>([]);
  let submenuExpanded = $state({
    statistics: false,
    history: false,
    official: false,
  });
  function loadNavigationPreferences() {
    submenuExpanded = { statistics: false, history: false, official: false };
    try {
      const saved = JSON.parse(
        localStorage.getItem(`marksix:menus:${encodeURIComponent(username)}`) ??
          "{}",
      );
      for (const key of ["statistics", "history", "official"] as const)
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
    return tab === id && submenuExpanded[id as keyof typeof submenuExpanded];
  }
  function hasSubmenu(id: Tab) {
    return (
      id === "statistics" ||
      id === "official" ||
      (id === "history" && historyTabs.length > 0)
    );
  }
  async function closeHistoryTab(id: string) {
    const index = historyTabs.findIndex((p) => p.id === id);
    historyTabs = historyTabs.filter((p) => p.id !== id);
    if (selectedPeriod?.id === id) {
      const next = historyTabs[Math.min(index, historyTabs.length - 1)];
      if (next) await openPeriod(next);
      else await navigate("history");
    }
    await tick();
    const target = selectedPeriod
      ? document.getElementById(`history-period-${selectedPeriod.id}`)
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
  let selectedPeriod = $state<Period | null>(null);
  let history = $state<Page<Period>>({
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
  const active = $derived(selectedPeriod ?? today);
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
    {
      id: "official" as Tab,
      label: "官方频道",
      short: "频道",
      icon: ArrowUpRight,
    },
  ];
  const riskFresh = $derived(
    !!active &&
      active.risk_status === "complete" &&
      active.risk_version === active.bet_version &&
      !!active.risk_result,
  );
  const risk = $derived(riskFresh ? active?.risk_result : null);
  const profitMax = $derived(risk ? Math.max(0, risk.max_net) : null);
  const lossMax = $derived(risk ? Math.max(0, -risk.min_net) : null);
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
      `/periods/${id}/bet-filters`,
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
      if (!selectedPeriod && boot && data.today.id !== boot.today.id) {
        selectedBettors = [];
        selectedPlays = [];
        records.page = 1;
      }
      boot = data;
      serverOffset = new Date(data.today.server_time).getTime() - Date.now();
      if (selectedPeriod) {
        const id = selectedPeriod.id;
        const updated = await api<Period>(`/periods/${id}`);
        if (selectedPeriod?.id === id) selectedPeriod = updated;
      }
      if (
        tab === "overview" ||
        tab === "bet" ||
        (tab === "statistics" && statisticsCategory === "records") ||
        (tab === "history" && selectedPeriod)
      )
        await loadRecords(records.page);
      if (active && tab !== "official")
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
        `/periods/${id}/statistics?page=${page}`,
      );
      if (active?.id === id && request === statisticsRequest) report = next;
    } catch (e) {
      notify(fail(e));
    }
  }
  async function loadHistory(page = 1) {
    history = await api(
      `/periods?page=${page}&search=${encodeURIComponent(search)}`,
    );
  }
  async function navigate(next: Tab) {
    tab = next;
    selectedPeriod = null;
    selectedBettors = [];
    selectedPlays = [];
    recordOrder = "newest";
    minAmount = "";
    maxAmount = "";
    globalError = "";
    try {
      if (next === "history") await loadHistory();
      else if (next !== "official" && next !== "settings") {
        await loadRecords();
        if (active) await loadStatistics();
      }
    } catch (e) {
      globalError = fail(e);
    }
  }
  async function openPeriod(period: Period) {
    if (!historyTabs.some((p) => p.id === period.id))
      historyTabs = [...historyTabs, period];
    selectedPeriod = period;
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
  async function retryRisk() {
    if (!active) return;
    busy = true;
    try {
      await api(`/periods/${active.id}/risk`, { method: "POST", body: "{}" });
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
      notify("整条投注已撤销，审计记录已保留");
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
      notify("飞出记录已作废，审计记录已保留");
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
  <aside class="sidebar glass">
    <a
      class="brand"
      href="#overview"
      onclick={(e) => {
        e.preventDefault();
        void navigate("overview");
      }}
      ><div class="brand-mark">M</div>
      <span>MarkSix<span class="brand-dot">.</span></span></a
    ><span class="sidebar-label">工作空间</span>
    <nav aria-label="主要导航" use:glassNavigation={tab}>
      <div class="nav-indicator" aria-hidden="true"></div>
      {#each nav as item}<div class="nav-item">
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
                !(item.id === "history" && selectedPeriod)
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
              onclick={() => {
                if (tab !== item.id) {
                  void navigate(item.id);
                  if (!submenuExpanded[item.id as keyof typeof submenuExpanded])
                    toggleSubmenu(item.id);
                } else toggleSubmenu(item.id);
              }}
            >
              <ChevronDown
                size={15}
                class={menuIsOpen(item.id) ? "expanded" : ""}
              />
            </button>
          {/if}
          {#if item.id === "statistics" && tab === "statistics" && submenuExpanded.statistics}<div
              class="nav-submenu"
              id="submenu-statistics"
              aria-label="本期统计分类"
            >
              {#each [{ id: "all", label: "全部受注统计" }, { id: "receivers", label: "飞出受注统计" }, { id: "bettors", label: "投注人分类统计" }, { id: "records", label: "投注记录" }] as sub}<button
                  class:active={statisticsCategory === sub.id}
                  aria-current={statisticsCategory === sub.id
                    ? "location"
                    : undefined}
                  onclick={() => {
                    statisticsCategory = sub.id as typeof statisticsCategory;
                    if (sub.id === "records")
                      void loadRecords(1).catch((e) => notify(fail(e)));
                  }}>{sub.label}</button
                >{/each}
            </div>{/if}
          {#if item.id === "history" && tab === "history" && historyTabs.length && submenuExpanded.history}<div
              class="nav-submenu history-tabs"
              id="submenu-history"
              aria-label="已打开的历史期次"
            >
              {#each historyTabs as period (period.id)}
                <div
                  class="history-tab"
                  class:active={selectedPeriod?.id === period.id}
                >
                  <button
                    class:active={selectedPeriod?.id === period.id}
                    aria-current={selectedPeriod?.id === period.id
                      ? "location"
                      : undefined}
                    id={`history-period-${period.id}`}
                    onclick={() => openPeriod(period)}>第 {period.id} 期</button
                  >
                  <button
                    class="history-tab-close"
                    aria-label={`关闭第 ${period.id} 期标签`}
                    onclick={() => closeHistoryTab(period.id)}
                    ><X size={14} /></button
                  >
                </div>
              {/each}
            </div>{/if}
          {#if item.id === "official" && tab === "official" && submenuExpanded.official}<div
              class="nav-submenu"
              id="submenu-official"
            >
              <button class="active" aria-current="location">调码助手</button>
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
    use:pageFade={`${tab}:${selectedPeriod?.id ?? ""}:${statisticsCategory}:${historyCategory}`}
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
        ><button
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
    {:else if (tab === "overview" || (tab === "history" && selectedPeriod)) && active}
      <section class="page-heading">
        <div>
          {#if selectedPeriod}<button
              class="text-button back-link"
              onclick={() => navigate("history")}
              ><ArrowLeft size={14} /> 返回历史统计</button
            >{:else}<span class="eyebrow">YOUR DAILY OVERVIEW</span>{/if}
          <h1>
            {selectedPeriod ? `历史统计 · 第 ${active.id} 期` : "本期概览"}
          </h1>
          <p>
            {active.business_date.replaceAll("-", " / ")}
            <span class="separator">·</span>
            第 <strong>{active.id}</strong> 期
            <span class="status-badge" data-phase={active.phase}
              ><i></i>{phases[active.phase] ?? active.phase}</span
            >
          </p>
        </div>
        <button class="button primary" onclick={() => navigate("bet")}
          ><Plus size={17} /> 录入投注</button
        >
      </section>
      <div class="stats-grid">
        <article class="stat glass">
          <div class="stat-label">
            有效投注本金<span class="stat-icon blue-tone"
              ><Wallet size={17} /></span
            >
          </div>
          <strong class="stat-value">{money(active.totals.stake)}</strong>
          <div class="stat-foot">
            <span>{active.totals.records} 个有效分项</span><i></i><span
              >{active.totals.units} 条基础注</span
            >
          </div>
        </article>
        <article class="stat glass">
          <div class="stat-label">
            {active.state === "settled" ? "总反水" : "预计总反水"}<span
              class="stat-icon purple-tone"><Coins size={17} /></span
            >
          </div>
          <strong class="stat-value">{money(active.totals.rebate)}</strong>
          <div class="stat-foot">逐注计算 <i></i> 精确到分</div>
        </article>
        <article class="stat glass">
          <div class="stat-label">
            {active.state === "settled" ? "中奖总返还" : "最大可能净盈利"}<span
              class="stat-icon green-tone"><ArrowUpRight size={17} /></span
            >
          </div>
          <strong class="stat-value" class:positive={active.state !== "settled"}
            >{active.state === "settled"
              ? money(active.totals.payout)
              : money(profitMax)}</strong
          >
          <div class="stat-foot">
            {active.state === "settled"
              ? "已包含中奖本金"
              : riskFresh
                ? "最佳合法开奖情形"
                : "等待精确计算"}
          </div>
        </article>
        <article class="stat glass">
          <div class="stat-label">
            {active.state === "settled" ? "自留净盈亏" : "最大可能净亏损"}<span
              class="stat-icon coral-tone"><ArrowDownLeft size={17} /></span
            >
          </div>
          <strong
            class="stat-value"
            class:negative={active.state !== "settled" ||
              (active.totals.retained_net ?? 0) < 0}
            class:positive={active.state === "settled" &&
              (active.totals.retained_net ?? 0) >= 0}
            >{active.state === "settled"
              ? signed(active.totals.retained_net)
              : money(lossMax)}</strong
          >
          <div class="stat-foot">
            {active.state === "settled"
              ? "原受注净盈亏加飞出净盈亏"
              : riskFresh
                ? "最坏合法开奖情形"
                : "单一期次 · 统一结果"}
          </div>
        </article>
      </div>
      <div class="insights-grid">
        <section class="draw-panel glass">
          <div class="section-head">
            <div>
              <span class="eyebrow">DRAW RESULTS</span>
              <h2>
                {active.draw ? "当期开奖结果" : "静候开奖，数据就绪。"}
              </h2>
            </div>
            <span class="soft-chip"
              ><Clock3 size={13} />{active.draw
                ? active.draw.open_time.slice(11, 16)
                : "21:34 自动同步"}</span
            >
          </div>
          <Balls
            numbers={active.draw?.numbers}
            mapping={active.mapping}
            zodiac={active.draw?.zodiac}
            waves={active.draw?.waves}
          />
          <div class="draw-footer">
            <span
              ><span class="tiny-dot" class:green={active.state === "settled"}
              ></span>{active.state === "settled"
                ? "本期结算已完成"
                : active.state === "missing"
                  ? "开奖缺失，投注保留待结算"
                  : "结果经校验后自动结算"}</span
            ><small
              >{active.last_fetch_at
                ? `最近同步 ${time(active.last_fetch_at)}`
                : "按北京时间同步"}</small
            >
          </div>
          {#if active.error}<div class="inline-error subtle">
              <AlertCircle size={15} />{active.error}
            </div>{/if}{#if active.mapping_warning}<div
              class="inline-error subtle"
            >
              <Info size={15} />接口映射与配置存在差异，已按接口实际数据结算。
            </div>{/if}
        </section>
        <section class="risk-panel glass">
          <div class="section-head">
            <div>
              <span class="eyebrow">EXPOSURE INSIGHT</span>
              <h2>
                {active.state === "settled" ? "本期收支" : "盘口风险洞察"}
              </h2>
            </div>
            <span class="stat-icon purple-tone"><Activity size={18} /></span>
          </div>
          {#if active.state === "settled"}<div class="ledger-row">
              <span>原受注毛利</span><strong
                >{signed(active.totals.gross)}</strong
              >
            </div>
            <div class="ledger-row">
              <span>赢注 / 输注本金</span><strong
                >{money(active.totals.winning_stake)} / {money(
                  active.totals.losing_stake,
                )}</strong
              >
            </div>
            <div class="risk-caption">
              <CheckCircle2 size={15} /> 所有有效基础注已完成结算
            </div>{:else if riskFresh && risk}<div class="risk-state">
              <span class="status-badge"><Check size={13} /> 精确计算完成</span
              ><small>{(risk.elapsed_ms / 1000).toFixed(2)} 秒</small>
            </div>
            <div class="risk-scale"><span></span></div>
            <div class="risk-endpoints">
              <span
                >最有利情形<strong class="positive"
                  >{signed(risk.max_net)}</strong
                ></span
              ><span
                >最不利情形<strong class="negative"
                  >{signed(risk.min_net)}</strong
                ></span
              >
            </div>
            <details class="risk-examples">
              <summary>查看极值示例开奖 <ChevronDown size={14} /></summary>
              <p>最佳情形</p>
              <Balls
                numbers={risk.best_draw}
                mapping={active.mapping}
                compact
              />
              <p>最坏情形</p>
              <Balls
                numbers={risk.worst_draw}
                mapping={active.mapping}
                compact
              />
            </details>
            <div class="risk-caption">
              <ShieldCheck size={14} /> 基于本期映射及同一个合法开奖结果
            </div>{:else}<div class="risk-pending">
              {#if ["queued", "computing"].includes(active.risk_status)}<span
                  class="loading-orbit"><Activity size={27} /></span
                ><strong>正在精确计算</strong>
                <p>录入可继续，旧结果不会被当作当前风险。</p>{:else}<span
                  class="loading-orbit"><AlertCircle size={27} /></span
                ><strong
                  >{active.risk_status === "timeout"
                    ? "计算超时"
                    : active.risk_status === "failed"
                      ? "计算未完成"
                      : "尚无当前风险结果"}</strong
                >
                <p>
                  {active.risk_error ??
                    "投注变化后会重新计算，未使用估算结果。"}
                </p>
                {#if active.state === "pending"}<button
                    class="button secondary"
                    disabled={busy}
                    onclick={retryRisk}>重新计算</button
                  >{/if}{/if}
            </div>{/if}
        </section>
      </div>
      {#if selectedPeriod}<div
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
          <button
            class:active={historyCategory === "receivers"}
            onclick={() => (historyCategory = "receivers")}>飞出受注统计</button
          >
        </div>{/if}
      {#if report && report.period === active.id}<StatisticsPanel
          {report}
          {api}
          compact={!selectedPeriod}
          category={selectedPeriod ? historyCategory : "bettors"}
          onbettor={filterBettor}
          onpage={loadStatistics}
        />{/if}
      <RecordsTable
        {records}
        {recordChoices}
        historical={!!selectedPeriod}
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
        onbet={() => navigate("bet")}
      />
    {:else if tab === "bet"}
      <section class="page-heading">
        <div>
          <span class="eyebrow">MAKE EVERY RECORD COUNT</span>
          <h1>录入投注</h1>
          <p>
            第 <strong>{today.id}</strong> 期
            <span class="separator">·</span>
            {today.close_time} 封盘
            <span class="status-badge" data-phase={today.phase}
              ><i></i>{phases[today.phase]}</span
            >
          </p>
        </div>
        <button class="button secondary" onclick={() => navigate("overview")}
          ><LayoutDashboard size={16} /> 本期概览</button
        >
      </section>
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
    {:else if tab === "history"}
      <section class="page-heading">
        <div>
          <span class="eyebrow">EVERY PERIOD, IN PERSPECTIVE</span>
          <h1>历史统计</h1>
          <p>回看开奖记录与收支，只将已结算期次计入实际盈亏。</p>
        </div>
        <span class="heading-icon glass"><History size={24} /></span>
      </section>
      <section class="glass history-panel">
        <div class="section-head">
          <h2>历史期次 <span class="count-badge">{history.total}</span></h2>
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
                ><th>期号 / 日期</th><th>状态</th><th>有效本金</th><th
                  >中奖返还</th
                ><th>反水</th><th>盘口净盈利</th><th>操作</th></tr
              ></thead
            ><tbody
              >{#each history.items as p}<tr
                  ><td
                    ><strong>{p.id}</strong><small>{p.business_date}</small></td
                  ><td
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
                    ><strong>{signed(p.totals.net)}</strong></td
                  ><td
                    ><button class="text-button" onclick={() => openPeriod(p)}
                      >查看 <ArrowRight size={14} /></button
                    ></td
                  ></tr
                >{/each}</tbody
            >
          </table>
          {#if !history.items.length}<div class="empty-state">
              <CalendarDays size={30} />
              <h3>还没有匹配的期次</h3>
              <p>试试其他期号或业务日期。</p>
            </div>{/if}
        </div>
        <div class="table-footer">
          <span>共 {history.total} 期 · 已实现盈亏不含待结算期次</span>
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
          <span class="eyebrow">CURRENT PERIOD</span>
          <h1>本期统计</h1>
          <p>
            第 <strong>{today.id}</strong> 期 · {statisticsCategory ===
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
          historical={!!selectedPeriod}
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
          onbet={() => navigate("bet")}
        />
      {:else if report && report.period === today.id}<StatisticsPanel
          {report}
          {api}
          category={statisticsCategory}
          onpage={loadStatistics}
        />{:else}<div class="empty-panel glass">正在加载本期统计…</div>{/if}
    {:else if tab === "official"}
      <section class="page-heading">
        <div>
          <span class="eyebrow">OFFICIAL CHANNEL</span>
          <h1>调码助手</h1>
          <p>macaujc.com 官方网页 · 页面内容及生肖口径由外部网站提供。</p>
        </div>
        <a
          class="button secondary"
          href="https://macaujc.com/picker/"
          target="_blank"
          rel="noopener noreferrer">在新窗口打开 <ArrowUpRight size={16} /></a
        >
      </section>
      <section class="glass official-panel">
        <iframe
          title="macaujc.com 官方调码助手"
          src="https://macaujc.com/picker/"
          referrerpolicy="no-referrer"
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        ></iframe>
        <p class="field-help">
          若官网限制内嵌或网络暂时不可用，请使用上方新窗口入口。
        </p>
      </section>
    {:else if tab === "settings"}
      <section class="page-heading">
        <div>
          <span class="eyebrow">BUILT AROUND YOUR RULES</span>
          <h1>玩法与配置</h1>
          <p>配置玩法与生效时间，已记录的投注始终保留原始规则。</p>
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
          ><Layers3 size={20} /><span
            >玩法设置<small>导入、导出与批量管理</small></span
          ></button
        ><button
          class:active={settingsSection === "system"}
          aria-pressed={settingsSection === "system"}
          onclick={() => (settingsSection = "system")}
          ><Settings2 size={20} /><span
            >配置设置<small>投注时间、生肖及账号授权</small></span
          ></button
        >
      </section>
      {#if settingsSection === "plays"}
        <section class="glass plays-panel">
          <div class="section-head">
            <h2>
              玩法配置 <span class="count-badge">{boot?.plays.length ?? 0}</span
              >
            </h2>
            <span class="soft-chip"><ShieldCheck size={13} /> 版本留存</span>
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
          <div class="panel-note">
            <Info size={15} /> 默认采用 plays-prop 配置；同名导入会更新当前规则，正式录入前请核对赔率及反水。
          </div>
        </section>
      {:else}
        <PasswordChange {api} onchanged={onlogout} />
        <SystemSettings
          {username}
          {today}
          {licenseStatus}
          {api}
          {notify}
          oncleared={async () => {
            selectedPeriod = null;
            historyTabs = [];
            detail = null;
            report = null;
            parties = { bettors: [], receivers: [] };
            await refresh();
          }}
        />
      {/if}
    {/if}
  </main>
</div>

{#if licenseStatus.active}
  {#if slipDetail}<SlipDetail
      record={slipDetail}
      canCancel={today?.phase === "open" && today?.id === slipDetail.period_id}
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
            >{detail.record.period_id} · {time(detail.record.created_at)}</span
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
      <div class="detail-info">
        <span
          >投注人 <strong>{detail.record.bettor || "未登记（旧记录）"}</strong
          ></span
        >
        <span>基础注 <strong>{detail.atoms.length}</strong></span><span
          >每注本金 <strong>{money(detail.record.amount)}</strong></span
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
              ><th>组合</th><th>赔率</th><th>结果</th><th>含本返还</th><th
                >反水</th
              ><th>盘口净盈亏</th></tr
            ></thead
          ><tbody
            >{#each detail.atoms.slice((detailPage - 1) * 50, detailPage * 50) as atom, offset}{@const result =
                detail.results?.[(detailPage - 1) * 50 + offset]}<tr
                ><td
                  >{atom.options
                    .map((v) => label(detail!.record.rule.kind, v))
                    .join(" · ")}</td
                ><td
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
      {#if detail.layoffs.length}<section class="detail-ledger">
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
                  ><th>受注方</th><th>每注金额</th><th>飞出总额</th><th
                    >状态 / 本方盈亏</th
                  ><th>操作</th></tr
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
                      >{#if row.status === "pending" && today?.phase === "open" && row.period_id === today.id}<button
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
          >{#each detail.events as event}<p>
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
      {#if detail.record.status === "pending" && detail.record.period_id === today?.id && today.phase === "open"}<div
          class="modal-actions"
        >
          <button
            class="button secondary"
            onclick={() => openMutation(detail!.record, "amount")}
            >修改金额</button
          >
          <button
            class="button primary"
            onclick={() => openMutation(detail!.record, "layoffs")}>飞出</button
          >
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
          ><button
            type="button"
            class:active={mutationMode === "layoffs"}
            onclick={() => (mutationMode = "layoffs")}>飞出</button
          >
        </div>
        <p class="modal-description">
          {mutationTarget.bettor || "未登记"} · {mutationTarget.rule.name} · {mutationTarget.unit_count}
          条基础注 · 原每注 {money(mutationTarget.amount)}
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
          >{mutationMode === "amount"
            ? "修改后的每注金额（整数元）"
            : "每条基础注飞出金额（元）"}<input
            bind:value={mutationAmount}
            inputmode="decimal"
            required
          /></label
        >
        <p class="field-help">
          {mutationMode === "amount"
            ? "保留原规则和赔率，记录修改前后金额；不能低于已飞出金额。"
            : "原投注保留，所有基础注按相同每注金额飞出。沿用原注赔率、反水，逐注四舍五入；累计不得超过原注。"}
        </p>
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
        notify("玩法已保存，仅影响后续新投注");
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
      notify("所选玩法已更新，历史投注快照保留");
    }}
  />{/if}
