<script lang="ts">
  import { onMount } from "svelte";
  import {
    LayoutDashboard,
    Plus,
    History,
    Settings2,
    ArrowUpRight,
    ArrowDownLeft,
    ArrowRight,
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
    SlidersHorizontal,
    PanelLeftClose,
    ReceiptText,
    LockKeyhole,
    Eye,
    Trash2,
    Sparkles,
    CalendarDays,
    ArrowLeft,
    Info,
    X,
  } from "lucide-svelte";
  import LicenseCountdown from "./components/LicenseCountdown.svelte";
  import Activation from "./components/Activation.svelte";
  import type { LicenseStatus } from "./components/Activation.svelte";
  import StatisticsPanel from "./components/Statistics.svelte";
  import Balls from "./components/Balls.svelte";
  import Modal from "./components/Modal.svelte";
  import {
    api,
    ApiError,
    money,
    signed,
    time,
    label,
    options,
    basicCount,
    selectionBoundary,
    annualMapping,
    wave,
    zodiacs,
    kinds,
    scopes,
    conditions,
    relations,
    phases,
  } from "./lib/types";
  import type {
    Bootstrap,
    Period,
    Play,
    Bet,
    Page,
    Detail,
    Quote,
    Rule,
    Settings,
    Mapping,
    Kind,
    Statistics,
    Layoff,
  } from "./lib/types";

  type Tab =
    | "overview"
    | "bet"
    | "history"
    | "settings"
    | "statistics"
    | "official";
  const amountPattern = /^\d+$/;
  let tab = $state<Tab>("overview");
  let boot = $state<Bootstrap | null>(null);
  let loggedIn = $state(false),
    loading = $state(true),
    busy = $state(false),
    refreshing = $state(false);
  let username = $state(""),
    password = $state(""),
    loginError = $state(""),
    globalError = $state("");
  let licenseStatus = $state<LicenseStatus | null>(null);
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
      selectedPeriod = null;
      detail = null;
      report = null;
      parties = { bettors: [], receivers: [] };
      await refresh();
      notify("历史记录已永久清空，本期数据和玩法配置已保留");
    } catch (e) {
      clearHistoryError = fail(e);
    } finally {
      busy = false;
    }
  }
  let toast = $state("");
  let toastTimer: ReturnType<typeof setTimeout>;
  let records = $state<Page<Bet>>({
    items: [],
    total: 0,
    page: 1,
    page_size: 25,
  });
  let bettor = $state("");
  let minAmount = $state("");
  let maxAmount = $state("");
  let report = $state<Statistics | null>(null);
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
  let openTime = $state("08:00");
  let settingsUsername = $state("");
  let settingsPassword = $state("");
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
  let playId = $state(0),
    selections = $state<number[]>([]),
    compound = $state(false),
    amount = $state("100");
  let quote = $state<Quote | null>(null),
    quoteState = $state<"idle" | "loading" | "ready" | "error">("idle"),
    quoteError = $state("");
  let config = $state<Settings | null>(null),
    closeTime = $state("21:28");
  let mapping = $state<Mapping>({
      zodiac: Array.from({ length: 49 }, (_, i) => (18 - (i % 12)) % 12),
      natal: 6,
    }),
    effectiveDate = $state("");
  let editor = $state(false),
    editId = $state<number | null>(null),
    editVersion = $state(0),
    enabled = $state(true),
    editError = $state("");
  let rule = $state<Rule>(newRule());
  let playSearch = $state("");
  let selectionError = $state("");
  let deletePlayTarget = $state<Play | null>(null);
  let importFile = $state<{
    format: string;
    schema: number;
    plays: { rule: Rule; enabled: boolean }[];
  } | null>(null);
  let importError = $state("");
  let importInput = $state<HTMLInputElement>();
  const matchingPlays = $derived(
    boot?.plays.filter(
      (p) =>
        p.enabled &&
        p.rule.name
          .toLocaleLowerCase()
          .includes(playSearch.trim().toLocaleLowerCase()),
    ) ?? [],
  );
  let currentTime = $state(Date.now());
  let serverOffset = 0;
  const today = $derived(boot?.today ?? null);
  const active = $derived(selectedPeriod ?? today);
  const currentPlay = $derived(
    boot?.plays.find((p) => p.id === playId && p.enabled) ??
      boot?.plays.find((p) => p.enabled),
  );
  const nav = [
    {
      id: "overview" as Tab,
      label: "本期概览",
      short: "概览",
      icon: LayoutDashboard,
    },
    { id: "bet" as Tab, label: "录入投注", short: "投注", icon: Plus },
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
  const selectedCount = $derived(
    currentPlay ? basicCount(currentPlay.rule, selections, compound) : 0,
  );
  const inputValid = $derived(
    !!currentPlay &&
      selectedCount > 0 &&
      selectedCount <= 1000 &&
      /^\d+$/.test(amount) &&
      BigInt(amount) > 0n,
  );
  const stakePreview = $derived(
    /^\d+$/.test(amount) ? BigInt(amount) * BigInt(selectedCount) * 100n : 0n,
  );
  const quoteKey = $derived(
    inputValid && today && currentPlay
      ? JSON.stringify({
          period: today.id,
          play_id: currentPlay.id,
          play_version: currentPlay.version,
          selections:
            currentPlay.rule.condition === "hard_pair"
              ? [...selections]
              : [...selections].sort((a, b) => a - b),
          bettor: bettor.trim(),
          compound,
          amount,
          request_id: "00000000-0000-4000-8000-000000000001",
        })
      : "",
  );
  const riskFresh = $derived(
    !!active &&
      active.risk_status === "complete" &&
      active.risk_version === active.bet_version &&
      !!active.risk_result,
  );
  const risk = $derived(riskFresh ? active?.risk_result : null);
  const profitMax = $derived(
    risk && active
      ? Math.max(
          0,
          risk.max_net ??
            active.totals.stake - risk.min_payout - active.totals.rebate,
        )
      : null,
  );
  const lossMax = $derived(
    risk && active
      ? Math.max(
          0,
          -(
            risk.min_net ??
            active.totals.stake - risk.max_payout - active.totals.rebate
          ),
        )
      : null,
  );
  const serverClock = $derived(
    new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date(currentTime)),
  );
  let pendingSubmission: { key: string; id: string } | null = null;
  function newRule(): Rule {
    return {
      name: "",
      kind: "number",
      scope: "special",
      condition: "all",
      relation: "eq",
      quantity: 1,
      combination_size: 1,
      compound_enabled: false,
      selection_limit: null,
      zodiac_count: null,
      special_hit_odds: null,
      minimum_hits: 1,
      odds: "43",
      rebate_percent: "2",
      special_odds: null,
      zero_tail_odds: null,
      special_rebate_percent: null,
    };
  }
  function notify(message: string) {
    toast = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ""), 4000);
  }
  function fail(error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      loggedIn = false;
      boot = null;
      password = "";
    }
    if (error instanceof ApiError && error.status === 402) {
      void api<LicenseStatus>("/license")
        .then((value) => (licenseStatus = value))
        .catch(() => {});
    }
    return error instanceof Error ? error.message : "操作失败，请重试";
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
      bettors: JSON.stringify(selectedBettors),
      play_ids: JSON.stringify(selectedPlays),
    };
    const next = await api<Page<Bet>>("/bets/search", {
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
      licenseStatus = await api<LicenseStatus>("/license");
      if (!licenseStatus.active) return;
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
  async function loadSettings() {
    config = await api<Settings>("/settings");
    closeTime = config.closing[0]?.close_time ?? "21:28";
    openTime = config.closing[0]?.open_time ?? "08:00";
    settingsUsername = username;
    settingsPassword = "";
    effectiveDate = config.tomorrow;
    mapping = structuredClone($state.snapshot(today?.mapping ?? mapping));
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
      else if (next === "settings") await loadSettings();
      else if (next !== "official") {
        await loadRecords();
        if (active) await loadStatistics();
      }
    } catch (e) {
      globalError = fail(e);
    }
  }
  async function openPeriod(period: Period) {
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
  async function signIn(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    loginError = "";
    try {
      await api("/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      password = "";
      loggedIn = true;
      await refresh();
    } catch (e) {
      loginError = fail(e);
    } finally {
      busy = false;
    }
  }
  async function signOut() {
    try {
      await api("/logout", { method: "POST", body: "{}" });
      loggedIn = false;
      licenseStatus = null;
      boot = null;
      tab = "overview";
      selectedPeriod = null;
    } catch (e) {
      notify(fail(e));
    }
  }
  function selectPlay(value: number) {
    playId = value;
    const selectedRule = boot?.plays.find((play) => play.id === value)?.rule;
    selections =
      selectedRule?.kind === "zodiac_count" && selectedRule.zodiac_count != null
        ? [selectedRule.zodiac_count]
        : [];
    compound = false;
    selectionError = "";
  }
  function setCompound(next: boolean) {
    if (currentPlay) {
      const error = selectionBoundary(currentPlay.rule, selections, next);
      if (error) {
        selectionError = error;
        notify(error);
        return;
      }
    }
    selectionError = "";
    compound = next;
  }
  function toggleOption(value: number) {
    if (selections.includes(value)) {
      selections = selections.filter((n) => n !== value);
      selectionError = "";
      return;
    }
    const next = [...selections, value];
    const error = currentPlay
      ? selectionBoundary(currentPlay.rule, next, compound)
      : null;
    if (error) {
      selectionError = error;
      notify(error);
      return;
    }
    selectionError = "";
    selections = next;
  }
  function matchPlay() {
    const exact = matchingPlays.find((p) => p.rule.name === playSearch.trim());
    if (exact || matchingPlays.length === 1)
      selectPlay((exact ?? matchingPlays[0]).id);
  }
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
      const result = await api<{ imported: number }>("/plays/import", {
        method: "POST",
        body: JSON.stringify(importFile),
      });
      importFile = null;
      notify(`已新增 ${result.imported} 条玩法`);
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
      selections = [];
      notify("玩法已删除，历史投注保留");
      await refresh();
    } catch (e) {
      notify(fail(e));
    } finally {
      busy = false;
    }
  }
  async function submitBet() {
    if (!inputValid || !quoteKey || !bettor.trim()) return;
    busy = true;
    const body = JSON.parse(quoteKey);
    delete body.request_id;
    const key = JSON.stringify(body);
    if (!pendingSubmission || pendingSubmission.key !== key)
      pendingSubmission = { key, id: crypto.randomUUID() };
    try {
      await api("/bets", {
        method: "POST",
        body: JSON.stringify({ ...body, request_id: pendingSubmission.id }),
      });
      pendingSubmission = null;
      selections = [];
      notify("投注已记录，正在更新本期风险");
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
  function changeCondition(value: Rule["condition"]) {
    rule.condition = value;
    if (value === "hard_pair" || value === "soft_pair")
      rule.zero_tail_odds = null;
    if (rule.condition === "hard_pair" || rule.condition === "soft_pair") {
      rule.kind = "number";
      rule.scope = "all";
      rule.relation = "eq";
      rule.quantity = 2;
      rule.combination_size = 2;
      rule.compound_enabled = false;
    }
  }
  function openEditor(play?: Play) {
    editId = play?.id ?? null;
    editVersion = play?.version ?? 0;
    rule = {
      zodiac_count: null,
      special_hit_odds: null,
      zero_tail_odds: null,
      ...structuredClone($state.snapshot(play?.rule ?? newRule())),
    };
    enabled = play?.enabled ?? true;
    editError = "";
    editor = true;
  }
  function changeKind(value: Kind) {
    rule.kind = value;
    if (value !== "tail") rule.zero_tail_odds = null;
    rule.zodiac_count = null;
    rule.special_hit_odds = null;
    rule.selection_limit = null;
    rule.quantity = 1;
    rule.combination_size = 1;
    if (value === "wave") rule.scope = "special";
    if (value === "zodiac_count") {
      rule.zodiac_count = 4;
      rule.scope = "all";
      rule.condition = "all";
      rule.relation = "eq";
      rule.compound_enabled = false;
      rule.selection_limit = 1;
    }
    if (value === "wave" || value === "zodiac_count") {
      rule.special_odds = null;
      rule.special_rebate_percent = null;
    }
    if (["hard_pair", "soft_pair"].includes(rule.condition))
      rule.condition = "all";
  }
  async function savePlay(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    editError = "";
    if (!rule.compound_enabled) rule.combination_size = rule.quantity;
    if (
      !(
        rule.kind === "number" &&
        rule.scope === "all" &&
        rule.condition === "all" &&
        rule.relation === "eq" &&
        rule.quantity === 2 &&
        rule.combination_size === 2
      )
    )
      rule.special_hit_odds = null;
    try {
      await api(editId ? `/plays/${editId}` : "/plays", {
        method: editId ? "PUT" : "POST",
        body: JSON.stringify(
          editId ? { version: editVersion, rule, enabled } : rule,
        ),
      });
      editor = false;
      notify("玩法已保存，仅影响后续新投注");
      await refresh();
    } catch (e) {
      editError = fail(e);
    } finally {
      busy = false;
    }
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
  $effect(() => {
    const key = quoteKey;
    const isBetting = tab === "bet";
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
  onMount(() => {
    let alive = true;
    (async () => {
      try {
        const session = await api<{ username: string }>("/session");
        if (!alive) return;
        username = session.username;
        loggedIn = true;
        await refresh();
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 401)) loginError = fail(e);
      } finally {
        loading = false;
      }
    })();
    const poll = setInterval(() => {
      if (loggedIn && !document.hidden) void refresh(true);
    }, 6000);
    const clock = setInterval(
      () => (currentTime = Date.now() + serverOffset),
      1000,
    );
    return () => {
      alive = false;
      clearInterval(poll);
      clearInterval(clock);
      clearTimeout(toastTimer);
    };
  });
  let validAmount = $derived(amountPattern.test(amount));
</script>

<svelte:head
  ><title
    >{loggedIn
      ? `${nav.find((n) => n.id === tab)?.label} · MarkSix`
      : "登录 · MarkSix"}</title
  ></svelte:head
>
<div class="ambient ambient-one"></div>
<div class="ambient ambient-two"></div>
<div class="ambient ambient-three"></div>
{#if loading}
  <div class="initial-loading">
    <div class="brand-mark">M</div>
    <LoaderCircle class="spin" size={22} />
    <p>正在打开你的工作台</p>
  </div>
{:else if !loggedIn}
  <main class="login-layout">
    <div class="login-story">
      <div class="brand">
        <div class="brand-mark">M</div>
        <span>MarkSix<span class="brand-dot">.</span></span>
      </div>
      <div class="login-copy">
        <span class="eyebrow">A CLEARER PERSPECTIVE</span>
        <h1>每一期，<br />都清晰在握<span class="blue">。</span></h1>
        <p>从一笔投注，到整个盘口。<br />让记录有序，让每一个数字有据可循。</p>
        <div class="login-tags">
          <span><ShieldCheck size={15} /> 独立账本</span><span
            ><Layers3 size={15} /> 精确结算</span
          ><span><Activity size={15} /> 风险洞察</span>
        </div>
      </div>
      <div class="login-art" aria-hidden="true">
        <div class="art-card art-back"></div>
        <div class="art-card art-front">
          <span>MARKSIX / INSIGHT</span>
          <div class="art-orbits"><i></i><i></i><i></i></div>
          <div class="art-bottom">
            <span>清晰 · 从容 · 掌控</span><ArrowUpRight size={20} />
          </div>
        </div>
      </div>
      <small class="login-copyright">MarkSix · 你的专属盘口工作台</small>
    </div>
    <section class="login-panel glass">
      <div class="login-icon"><LockKeyhole size={25} /></div>
      <h2>欢迎回来</h2>
      <p>登录客户账号，继续今天的工作。</p>
      <form onsubmit={signIn}>
        <label
          >客户账号<input
            autocomplete="username"
            bind:value={username}
            required
            maxlength="80"
            placeholder="输入客户账号"
          /></label
        ><label
          >登录密码<input
            type="password"
            autocomplete="current-password"
            bind:value={password}
            required
            maxlength="256"
            placeholder="输入你的密码"
          /></label
        >{#if loginError}<div class="inline-error" role="alert">
            <AlertCircle size={17} />{loginError}
          </div>{/if}<button class="button primary login-submit" disabled={busy}
          >{#if busy}<LoaderCircle
              size={17}
              class="spin"
            />{:else}进入工作台<ArrowRight size={17} />{/if}</button
        >
      </form>
      <div class="login-note">
        <ShieldCheck size={14} /> 仅授权账号可访问，客户账本相互隔离
      </div>
    </section>
  </main>
{:else if !licenseStatus?.active}<Activation
    status={licenseStatus}
    onactivated={async () => {
      await refresh();
    }}
    onlogout={signOut}
  />{:else}
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
      <nav aria-label="主要导航">
        {#each nav as item}<button
            class:active={tab === item.id}
            aria-label={item.label}
            aria-current={tab === item.id ? "page" : undefined}
            onclick={() => navigate(item.id)}
            ><item.icon size={19} strokeWidth={1.7} /><span class="nav-label"
              >{item.label}</span
            ><span class="nav-label-short" aria-hidden="true">{item.short}</span
            >{#if item.id === "bet"}<span class="nav-plus">＋</span
              >{/if}</button
          >
          {#if item.id === "statistics" && tab === "statistics"}<div
              class="nav-submenu"
            >
              {#each [{ id: "all", label: "全部受注统计" }, { id: "receivers", label: "飞出受注统计" }, { id: "bettors", label: "投注人分类统计" }, { id: "records", label: "投注记录" }] as sub}<button
                  class:active={statisticsCategory === sub.id}
                  onclick={() => {
                    statisticsCategory = sub.id as typeof statisticsCategory;
                    if (sub.id === "records")
                      void loadRecords(1).catch((e) => notify(fail(e)));
                  }}>{sub.label}</button
                >{/each}
            </div>{/if}
          {#if item.id === "history" && tab === "history" && selectedPeriod}<div
              class="nav-submenu"
            >
              <button class="active" aria-current="page"
                >第 {selectedPeriod.id} 期</button
              >
            </div>{/if}
          {#if item.id === "official" && tab === "official"}<div
              class="nav-submenu"
            >
              <button class="active" aria-current="page">调码助手</button>
            </div>{/if}
        {/each}
      </nav>
      <div class="sidebar-bottom">
        <div class="private-card">
          <span class="private-icon"><ShieldCheck size={19} /></span>
          <div>
            <strong>独立账本空间</strong><small>数据由你掌控</small>
          </div>
        </div>
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
        <span class="version">MARKSIX <span>Dev1.0</span></span>
      </div>
    </aside>
    <main class="main-content" id="main">
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
              <span>{active.totals.records} 条记录</span><i></i><span
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
              {active.state === "settled"
                ? "中奖总返还"
                : "最大可能净盈利"}<span class="stat-icon green-tone"
                ><ArrowUpRight size={17} /></span
              >
            </div>
            <strong
              class="stat-value"
              class:positive={active.state !== "settled"}
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
              {active.state === "settled"
                ? "自留净盈亏"
                : "最大可能净亏损"}<span class="stat-icon coral-tone"
                ><ArrowDownLeft size={17} /></span
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
                <h2>{active.draw ? "当期开奖结果" : "静候开奖，数据就绪。"}</h2>
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
                <span class="status-badge"
                  ><Check size={13} /> 精确计算完成</span
                ><small>{(risk.elapsed_ms / 1000).toFixed(2)} 秒</small>
              </div>
              <div class="risk-scale"><span></span></div>
              <div class="risk-endpoints">
                <span
                  >最有利情形<strong class="positive"
                    >{signed(
                      risk.max_net ??
                        active.totals.stake -
                          risk.min_payout -
                          active.totals.rebate,
                    )}</strong
                  ></span
                ><span
                  >最不利情形<strong class="negative"
                    >{signed(
                      risk.min_net ??
                        active.totals.stake -
                          risk.max_payout -
                          active.totals.rebate,
                    )}</strong
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
                  </p>{/if}
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
              onclick={() => (historyCategory = "bettors")}
              >投注人分类统计</button
            >
            <button
              class:active={historyCategory === "receivers"}
              onclick={() => (historyCategory = "receivers")}
              >飞出受注统计</button
            >
          </div>{/if}
        {#if report && report.period === active.id}<StatisticsPanel
            {report}
            compact={!selectedPeriod}
            category={selectedPeriod ? historyCategory : "bettors"}
            onbettor={filterBettor}
            onpage={loadStatistics}
          />{/if}
        {@render recordTable()}
      {:else if tab === "bet"}
        <section class="page-heading">
          <div>
            <span class="eyebrow">MAKE EVERY RECORD COUNT</span>
            <h1>录入投注</h1>
            <p>
              第 <strong>{today.id}</strong> 期 <span class="separator">·</span>
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
        <div class="bet-layout">
          <section class="bet-form glass">
            <div class="section-head">
              <h2><span class="step">01</span> 选择玩法</h2>
              <span class="muted small">规则由管理员配置</span>
            </div>
            <label class="play-search"
              >搜索玩法名称<input
                type="search"
                bind:value={playSearch}
                oninput={(event) => {
                  playSearch = event.currentTarget.value;
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
            {#if playSearch && !matchingPlays.length}<p class="field-help">
                没有匹配的玩法，请检查名称或在配置页创建。
              </p>{/if}
            <div class="play-picker">
              {#each matchingPlays as play}<button
                  class:selected={currentPlay?.id === play.id}
                  onclick={() => selectPlay(play.id)}
                  ><span>{play.rule.name}</span><small
                    >{kinds[play.rule.kind]} · {play.rule.odds} 倍</small
                  >{#if currentPlay?.id === play.id}<CheckCircle2
                      size={15}
                    />{/if}</button
                >{/each}
            </div>
            {#if !currentPlay}<div class="empty-state">
                <p>尚未配置可用玩法。</p>
                <button
                  class="button secondary"
                  onclick={() => navigate("settings")}>配置玩法</button
                >
              </div>{:else}<div class="rule-strip">
                <span
                  ><small>对比范围</small>{scopes[currentPlay.rule.scope]}</span
                ><span
                  ><small>命中条件</small>{conditions[
                    currentPlay.rule.condition
                  ]}</span
                ><span
                  ><small>基础注数量</small>{relations[
                    currentPlay.rule.relation
                  ]}
                  {currentPlay.rule.quantity} 个</span
                ><span
                  ><small>反水</small>{currentPlay.rule.rebate_percent}%</span
                >
              </div>
              <div class="section-head selection-heading">
                <h2><span class="step">02</span> 选择投注项</h2>
                {#if currentPlay.rule.compound_enabled}<div class="segmented">
                    <button
                      class:active={!compound}
                      aria-pressed={!compound}
                      onclick={() => setCompound(false)}>普通 / 多选</button
                    ><button
                      class:active={compound}
                      aria-pressed={compound}
                      onclick={() => setCompound(true)}>复式</button
                    >
                  </div>{/if}
              </div>
              {#if currentPlay.rule.kind === "zodiac_count"}<p
                  class="field-help"
                >
                  全部 7 个开奖号码恰好出现 {currentPlay.rule.zodiac_count} 种不同生肖时中奖；同一生肖出现多次只计一种。
                </p>{/if}
              {#if currentPlay.rule.special_hit_odds}<p class="field-help">
                  两平码按 {currentPlay.rule.odds} 倍；一特一平按 {currentPlay
                    .rule.special_hit_odds} 倍返还。
                </p>{/if}
              {#if currentPlay.rule.condition === "hard_pair"}<p
                  class="field-help"
                >
                  按顺序选择：第一个号码必须开在特码，第二个必须开在平码。当前：{selections
                    .map(
                      (n, i) =>
                        `${i === 0 ? "特码" : "平码"} ${label("number", n)}`,
                    )
                    .join(" → ") || "尚未选择"}
                </p>{/if}
              {#if currentPlay.rule.condition === "at_least"}<p
                  class="field-help"
                >
                  每注至少命中 {currentPlay.rule.minimum_hits} 个选项即中奖。
                </p>{/if}
              {#if currentPlay.rule.kind === "size" || currentPlay.rule.kind === "parity"}<p
                  class="field-help"
                >
                  所选开奖范围出现 49
                  时，本基础注和局退本，不计有效投注、无反水。
                </p>{/if}
              <div class="selection-description">
                <span
                  >{compound
                    ? `从候选项中每 ${currentPlay.rule.combination_size} 个拆成一注`
                    : `选择数量${relations[currentPlay.rule.relation]} ${currentPlay.rule.quantity} 个${currentPlay.rule.quantity === 1 ? "；多选逐项拆注" : "；允许的超额选择按阈值拆注"}`}</span
                ><button
                  class="text-button"
                  onclick={() => (selections = [])}
                  disabled={!selections.length}>清空选择</button
                >
              </div>
              <div
                class="option-grid"
                class:number-grid={currentPlay.rule.kind === "number"}
                class:zodiac-grid={currentPlay.rule.kind === "zodiac"}
              >
                {#each options(currentPlay.rule.kind).filter((value) => currentPlay.rule.kind !== "zodiac_count" || value === currentPlay.rule.zodiac_count) as value}<button
                    class="option"
                    class:selected={selections.includes(value)}
                    aria-pressed={selections.includes(value)}
                    aria-label={`${label(currentPlay.rule.kind, value)}${currentPlay.rule.kind === "number" ? ` ${zodiacs[today.mapping.zodiac[value - 1]]}` : ""}`}
                    onclick={() => toggleOption(value)}
                    >{#if currentPlay.rule.kind === "number"}<span
                        class="number-option"
                        data-wave={wave(value)}
                        >{label(currentPlay.rule.kind, value)}</span
                      ><small>{zodiacs[today.mapping.zodiac[value - 1]]}</small
                      >{:else}<span>{label(currentPlay.rule.kind, value)}</span
                      >{#if currentPlay.rule.kind === "zodiac" && value === today.mapping.natal}<small
                          >本命</small
                        >{/if}{/if}{#if selections.includes(value)}<span
                        class="selection-check"><Check size={10} /></span
                      >{/if}</button
                  >{/each}
              </div>
              {#if selectionError}<p class="inline-error" role="alert">
                  {selectionError}
                </p>{/if}
              <div class="selection-meta">
                {#if currentPlay.rule.zero_tail_odds != null}<span
                    >含 0 尾基础注赔率 <strong
                      >{currentPlay.rule.zero_tail_odds}</strong
                    > 倍</span
                  >{/if}
                <span>已选 <strong>{selections.length}</strong> 项</span
                >{#if currentPlay.rule.special_odds}<span
                    >含本命生肖基础注赔率 <strong
                      >{currentPlay.rule.special_odds}</strong
                    > 倍</span
                  >{/if}
              </div>
              <div class="section-head amount-heading">
                <h2><span class="step">03</span> 填写金额</h2>
                <span class="muted small">每条基础注的本金</span>
              </div>
              <label class="bettor-input"
                >投注人<input
                  bind:value={bettor}
                  list="bettor-suggestions"
                  maxlength="80"
                  autocomplete="off"
                  placeholder="手工填写姓名或代号"
                  required
                /></label
              >
              <label class="amount-input"
                ><span>¥</span><input
                  aria-label="每注金额"
                  inputmode="numeric"
                  pattern="[0-9]*"
                  bind:value={amount}
                  maxlength="16"
                /><small>元 / 注</small></label
              >
              <div class="quick-amounts">
                {#each ["10", "50", "100", "500", "1000"] as value}<button
                    class:active={amount === value}
                    onclick={() => (amount = value)}>{value} 元</button
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
                >{compound ? "复式" : selectedCount > 1 ? "多选" : "单注"}</span
              >
            </div>
            <div class="selected-tags">
              {#if selections.length}{#each selections.slice(0, 20) as value}<span
                    >{label(currentPlay!.rule.kind, value)}</span
                  >{/each}{#if selections.length > 20}<span
                    >+{selections.length - 20}</span
                  >{/if}{:else}<p>选择投注项后，在这里查看汇总。</p>{/if}
            </div>
            <div class="ledger-row">
              <span>基础注数量</span><strong
                >{selectedCount.toLocaleString()} 注</strong
              >
            </div>
            <div class="ledger-row">
              <span>每注本金</span><strong
                >{validAmount ? money(BigInt(amount) * 100n) : "—"}</strong
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
                <span>最大含本返还</span><strong
                  >{money(quote?.max_return)}</strong
                >
              </div>
              <div class="ledger-row">
                <span>预计反水</span><strong>{money(quote?.rebate)}</strong>
              </div>
              <div class="ledger-row">
                <span>最大净盈利（含反水）</span><strong
                  class:positive={(quote?.max_profit ?? 0) > 0}
                  class:negative={(quote?.max_profit ?? 0) < 0}
                  >{quote ? signed(quote.max_profit) : "—"}</strong
                >
              </div>
              {#if quoteError}<p class:negative={quoteState === "error"}>
                  {quoteError}
                </p>{:else}<p>基于同一个合法开奖结果精确计算。</p>{/if}
            </div>
            {#if selectedCount > 1000}<div class="inline-error">
                <AlertCircle size={15} />单次最多 1000 条基础注，请减少选项。
              </div>{/if}{#if today.phase !== "open"}<div
                class="notice compact-notice"
              >
                <Clock3 size={16} /><span
                  >当前{phases[today.phase]}，{today.open_time} 至 {today.close_time}
                  可提交。</span
                >
              </div>{/if}<button
              class="button primary submit-bet"
              disabled={busy ||
                !inputValid ||
                !bettor.trim() ||
                today.phase !== "open"}
              onclick={submitBet}
              >{#if busy}<LoaderCircle size={17} class="spin" />{:else}<Plus
                  size={17}
                />{/if}确认录入投注</button
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
                      ><strong>{p.id}</strong><small>{p.business_date}</small
                      ></td
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
          {@render recordTable()}
        {:else if report && report.period === today.id}<StatisticsPanel
            {report}
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
          <div class="configuration-actions">
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
          </div>
        </section>
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
                <LicenseCountdown
                  seconds={licenseStatus.remaining_seconds}
                />{/if}
            </p>
            <p class="field-help">
              授权截止日当期可用，到期后使用新激活码续期；已有投注继续结算。
            </p>
          </section>{/if}
        <section class="glass plays-panel">
          <div class="section-head">
            <h2>
              玩法配置 <span class="count-badge">{boot?.plays.length ?? 0}</span
              >
            </h2>
            <span class="soft-chip"><ShieldCheck size={13} /> 版本留存</span>
          </div>
          <div class="play-settings-grid">
            {#each boot?.plays ?? [] as play}<button
                class="play-setting"
                class:disabled-play={!play.enabled}
                onclick={() => openEditor(play)}
                ><div>
                  <span class="play-symbol"><Layers3 size={21} /></span><span
                    class="version-chip">V{play.version}</span
                  >
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
                  ><span class="edit-link">编辑 <ArrowUpRight size={15} /></span
                  >
                </div></button
              >{/each}
          </div>
          <div class="panel-note">
            <Info size={15} /> 初始玩法为说明书中的示例配置，正式录入前请核对赔率及反水。
          </div>
        </section>
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
                >新的开始时间<input
                  type="time"
                  bind:value={openTime}
                  required
                /></label
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
              <span class="soft-chip"
                >本期本命 · {zodiacs[today.mapping.natal]}</span
              >
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
                      (mapping = annualMapping(
                        Number(effectiveDate.slice(0, 4)),
                      ))}
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
                    >{#each zodiacs as zodiac, i}<option value={i}
                        >{zodiac}</option
                      >{/each}</select
                  ></label
                >
              </div>
              <details class="mapping-editor">
                <summary
                  >编辑 49 个号码对应的生肖 <ChevronDown size={15} /></summary
                >
                <div class="mapping-grid">
                  {#each mapping.zodiac as _, i}<label
                      ><span class="mini-number" data-wave={wave(i + 1)}
                        >{String(i + 1).padStart(2, "0")}</span
                      ><select
                        aria-label={`${String(i + 1).padStart(2, "0")} 生肖`}
                        bind:value={mapping.zodiac[i]}
                        >{#each zodiacs as z, index}<option value={index}
                            >{z}</option
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
      {/if}
      <footer class="page-footer">
        <span>MarkSix · 清晰记录，从容掌控</span><span
          ><ShieldCheck size={12} /> 人民币计价 <i>·</i> 北京时间</span
        >
      </footer>
    </main>
  </div>
{/if}

{#snippet recordTable()}
  <section class="records-panel glass">
    <div class="section-head">
      <div class="title-with-count">
        <h2>投注记录</h2>
        <span class="count-badge">{records.total}</span>
      </div>
      <span class="muted small">自动刷新 · 金额为整条投注本金</span>
    </div>
    <form
      class="record-filters"
      onsubmit={(e) => {
        e.preventDefault();
        void loadRecords(1).catch((e) => notify(fail(e)));
      }}
    >
      <label
        >投注总额下限（元）<input
          bind:value={minAmount}
          inputmode="decimal"
          placeholder="不限"
        /></label
      >
      <label
        >投注总额上限（元）<input
          bind:value={maxAmount}
          inputmode="decimal"
          placeholder="不限"
        /></label
      >
      <button class="button secondary" type="submit">筛选</button><button
        class="text-button"
        type="button"
        onclick={() => {
          selectedBettors = [];
          selectedPlays = [];
          recordOrder = "newest";
          minAmount = "";
          maxAmount = "";
          void loadRecords(1);
        }}>重置</button
      >
    </form>
    <div class="record-multifilters">
      <details class="record-picker">
        <summary
          >投注人多选{selectedBettors.length
            ? ` · ${selectedBettors.length} 位`
            : " · 全部"}</summary
        >
        <div class="record-picker-options">
          {#each recordChoices.bettors as name (name)}<label
              class="checkbox-label"
              ><input
                type="checkbox"
                value={name}
                bind:group={selectedBettors}
                onchange={() =>
                  queueMicrotask(
                    () => void loadRecords(1).catch((e) => notify(fail(e))),
                  )}
              />{name || "未登记"}</label
            >{/each}{#if !recordChoices.bettors.length}<p class="field-help">
              本期暂无投注人
            </p>{/if}
        </div>
      </details>
      <details class="record-picker">
        <summary
          >玩法多选{selectedPlays.length
            ? ` · ${selectedPlays.length} 项`
            : " · 全部"}</summary
        >
        <div class="record-picker-options">
          {#each recordChoices.plays as play (play.id)}<label
              class="checkbox-label"
              ><input
                type="checkbox"
                value={play.id}
                bind:group={selectedPlays}
                onchange={() =>
                  queueMicrotask(
                    () => void loadRecords(1).catch((e) => notify(fail(e))),
                  )}
              />{play.name}</label
            >{/each}{#if !recordChoices.plays.length}<p class="field-help">
              本期暂无投注玩法
            </p>{/if}
        </div>
      </details>
      <label
        >记录排序<select
          bind:value={recordOrder}
          onchange={() =>
            queueMicrotask(
              () => void loadRecords(1).catch((e) => notify(fail(e))),
            )}
          ><option value="newest">最新录入优先</option><option
            value="amount_asc">投注总额从小到大</option
          ><option value="amount_desc">投注总额从大到小</option></select
        ></label
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
            ><th>玩法 / 投注人 / 投注项</th><th>基础注</th><th>投注本金</th><th
              >反水</th
            ><th>盘口净盈利</th><th>状态</th><th>操作</th></tr
          ></thead
        ><tbody
          >{#each records.items as bet}<tr
              ><td
                ><strong
                  >{bet.rule.name}{#if bet.compound}<span class="table-tag"
                      >复式</span
                    >{:else if bet.unit_count > 1}<span class="table-tag"
                      >多选</span
                    >{/if}</strong
                ><small class="bettor-name"
                  >{bet.bettor || "未登记（旧记录）"}</small
                ><small class="bet-selection"
                  >{bet.selections
                    .map((v) => label(bet.rule.kind, v))
                    .join(" · ")}</small
                ></td
              ><td>{bet.unit_count} 注</td><td>{money(bet.stake)}</td><td
                >{bet.status === "cancelled" ? "—" : money(bet.rebate)}</td
              ><td
                class:positive={bet.payout !== null &&
                  bet.stake - bet.payout - bet.rebate > 0}
                class:negative={bet.payout !== null &&
                  bet.stake - bet.payout - bet.rebate < 0}
                ><strong
                  >{bet.status === "settled"
                    ? signed(bet.stake - bet.payout! - bet.rebate)
                    : bet.status === "cancelled"
                      ? "—"
                      : "待结算"}</strong
                ></td
              ><td
                ><span class="record-status" data-status={bet.status}
                  >{bet.status === "settled"
                    ? "已结算"
                    : bet.status === "cancelled"
                      ? "已撤销"
                      : "待开奖"}</span
                ></td
              ><td
                ><button class="text-button" onclick={() => showDetail(bet)}
                  >详情 <ArrowUpRight size={13} /></button
                ></td
              ></tr
            >{/each}</tbody
        >
      </table>
      {#if !records.items.length}<div class="empty-state record-empty">
          <span class="empty-icon"><ReceiptText size={28} /></span>
          <h3>清晰的记录，从第一笔开始</h3>
          <p>
            {selectedBettors.length ||
            selectedPlays.length ||
            minAmount ||
            maxAmount
              ? "暂无符合筛选条件的记录，可调整条件或重置筛选。"
              : "本期还没有投注记录，录入后会自动汇总到这里。"}
          </p>
          {#if !selectedPeriod}<button
              class="text-button"
              onclick={() => navigate("bet")}
              >录入第一笔投注 <ArrowRight size={15} /></button
            >{/if}
        </div>{/if}
    </div>
    <div class="table-footer">
      <span>共 {records.total} 条记录 <i>·</i> 盘口方盈亏口径</span>
      <div class="pagination">
        <button
          class="icon-button"
          aria-label="上一页记录"
          disabled={records.page === 1}
          onclick={() => loadRecords(records.page - 1)}
          ><ChevronLeft size={16} /></button
        ><span>{records.page}</span><button
          class="icon-button"
          aria-label="下一页记录"
          disabled={records.page * 25 >= records.total}
          onclick={() => loadRecords(records.page + 1)}
          ><ChevronRight size={16} /></button
        >
      </div>
    </div>
  </section>
{/snippet}

{#if loggedIn && licenseStatus?.active}
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
  {#if editor}<Modal
      title={editId ? "编辑玩法" : "新建玩法"}
      onclose={() => (editor = false)}
      ><form onsubmit={savePlay} class="rule-form">
        <label
          >玩法名称<input
            bind:value={rule.name}
            required
            maxlength="40"
            placeholder="例如：五有"
          /></label
        >
        <div class="form-two">
          <label
            >投注对象<select
              aria-label="投注对象"
              value={rule.kind}
              onchange={(e) => changeKind(e.currentTarget.value as Kind)}
              >{#each Object.entries(kinds) as [key, value]}<option value={key}
                  >{value}</option
                >{/each}</select
            ></label
          ><label
            >开奖对比范围<select
              bind:value={rule.scope}
              disabled={rule.kind === "wave" || rule.kind === "zodiac_count"}
              >{#each Object.entries(scopes) as [key, value]}<option value={key}
                  >{value}</option
                >{/each}</select
            ></label
          >
        </div>
        <label
          >命中条件<select
            value={rule.condition}
            disabled={rule.kind === "zodiac_count"}
            onchange={(e) =>
              changeCondition(e.currentTarget.value as Rule["condition"])}
            >{#each Object.entries(conditions) as [key, value]}<option
                value={key}>{value}</option
              >{/each}</select
          ></label
        >
        {#if rule.kind === "zodiac_count"}<label
            >目标生肖种数<input
              type="number"
              min="1"
              max="7"
              bind:value={rule.zodiac_count}
              required
            /></label
          >
          <p class="field-help">
            判断全部 7 球恰好开出几种不同生肖，投注时无需逐个选择生肖。
          </p>{/if}
        {#if rule.condition === "at_least"}<label
            >最少命中数量<input
              type="number"
              min="1"
              max="49"
              bind:value={rule.minimum_hits}
              required
            /></label
          >{/if}
        <label
          >最多可选数量（留空允许普通多选）<input
            type="number"
            min="1"
            max={options(rule.kind).length}
            value={rule.selection_limit ?? ""}
            oninput={(event) =>
              (rule.selection_limit = event.currentTarget.value
                ? Number(event.currentTarget.value)
                : null)}
          /></label
        >
        <label class="checkbox-label"
          ><input
            type="checkbox"
            bind:checked={rule.compound_enabled}
            disabled={rule.kind === "zodiac_count" ||
              rule.condition === "hard_pair" ||
              rule.condition === "soft_pair"}
          /> 启用复式投注</label
        >
        <div class="form-three">
          <label
            >数量关系<select
              bind:value={rule.relation}
              disabled={rule.kind === "zodiac_count"}
              >{#each Object.entries(relations) as [key, value]}<option
                  value={key}>{value}</option
                >{/each}</select
            ></label
          ><label
            >数量阈值<input
              type="number"
              min="1"
              max="49"
              bind:value={rule.quantity}
              disabled={rule.kind === "zodiac_count"}
              required
            /></label
          ><label
            >复式每注选项数<input
              disabled={!rule.compound_enabled}
              type="number"
              min="1"
              max="49"
              bind:value={rule.combination_size}
              required
            /></label
          >
        </div>
        <p class="field-help">
          普通投注须满足数量关系；单选玩法可多选逐项拆注。“不少于 5”选 7 个拆成
          21 注。“等于 5”未开复式时只能选 5
          个。最多可选数量对普通和复式均生效；复式拆分后的每注也须满足规则。
        </p>
        <div class="form-two">
          <label
            >含本赔率<input
              inputmode="decimal"
              bind:value={rule.odds}
              required
              placeholder="最多四位小数"
            /></label
          ><label
            >反水比例（%）<input
              inputmode="decimal"
              bind:value={rule.rebate_percent}
              required
              placeholder="0–100，最多两位小数"
            /></label
          >
        </div>
        {#if rule.kind === "number" && rule.scope === "all" && rule.condition === "all" && rule.relation === "eq" && rule.quantity === 2}<label
            class="checkbox-label"
            ><input
              type="checkbox"
              checked={rule.special_hit_odds != null}
              onchange={(e) =>
                (rule.special_hit_odds = e.currentTarget.checked ? "25" : null)}
            />启用一特一平赔率</label
          >{#if rule.special_hit_odds != null}<label
              >一特一平含本赔率<input
                inputmode="decimal"
                bind:value={rule.special_hit_odds}
                required
              /></label
            >
            <p class="field-help">
              两平码中奖沿用上方普通含本赔率；一号为特码、另一号为平码时使用此赔率，逐条基础注分别结算。
            </p>{/if}{/if}
        {#if rule.kind === "tail"}
          <label class="checkbox-label"
            ><input
              type="checkbox"
              checked={rule.zero_tail_odds != null}
              onchange={(e) =>
                (rule.zero_tail_odds = e.currentTarget.checked
                  ? rule.odds
                  : null)}
            />启用 0 尾特殊赔率</label
          >
          {#if rule.zero_tail_odds != null}<label
              >0 尾含本赔率<input
                inputmode="decimal"
                bind:value={rule.zero_tail_odds}
                required
                placeholder="最多四位小数"
              /></label
            >
            <p class="field-help">
              0 尾只有 10、20、30、40 四个号码。拆分后含 0
              尾的基础注使用此赔率；与本命肖特殊赔率重叠时优先使用 0
              尾赔率，反水仍按原规则。
            </p>{/if}
        {/if}
        {#if rule.kind !== "wave" && rule.kind !== "zodiac_count"}<label
            class="checkbox-label"
            ><input
              type="checkbox"
              checked={rule.special_odds !== null}
              onchange={(e) =>
                (rule.special_odds = e.currentTarget.checked ? "8" : null)}
            /> 启用本命生肖特殊赔率</label
          >{#if rule.special_odds !== null}<label
              >特殊含本赔率<input
                inputmode="decimal"
                bind:value={rule.special_odds}
                required
              /></label
            >
            <p class="field-help">
              按每条基础注是否包含本命生肖分别应用，全部不命中玩法同样适用。
            </p>{/if}
          <label class="checkbox-label"
            ><input
              type="checkbox"
              checked={rule.special_rebate_percent !== null}
              onchange={(e) =>
                (rule.special_rebate_percent = e.currentTarget.checked
                  ? "0"
                  : null)}
            /> 启用本命肖特殊反水</label
          >
          {#if rule.special_rebate_percent !== null}<label
              >本命肖反水（%）<input
                inputmode="decimal"
                bind:value={rule.special_rebate_percent}
                required
              /></label
            >{/if}
          <p class="field-help">
            号码、生肖、尾数、大小、单双均按当期映射逐条判断；含本命肖对应选项的基础注采用特殊值。
          </p>
        {/if}{#if editId}<label class="checkbox-label"
            ><input type="checkbox" bind:checked={enabled} /> 允许录入新投注</label
          >{/if}{#if editError}<div class="inline-error" role="alert">
            <AlertCircle size={16} />{editError}
          </div>{/if}
        <div class="modal-actions">
          {#if editId}<button
              type="button"
              class="button danger"
              disabled={busy}
              onclick={() => {
                deletePlayTarget =
                  boot?.plays.find((p) => p.id === editId) ?? null;
                editor = false;
              }}>删除玩法</button
            >
            <button
              type="button"
              class="button secondary"
              onclick={() => exportPlays(editId!)}>导出此玩法</button
            >{/if}
          <button
            type="button"
            class="button secondary"
            onclick={() => (editor = false)}>取消</button
          ><button class="button primary" disabled={busy}
            >{#if busy}<LoaderCircle size={16} class="spin" />{:else}<Check
                size={16}
              />{/if}保存玩法</button
          >
        </div>
      </form></Modal
    >{/if}
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
      将新增 {importFile.plays.length} 条玩法，不覆盖现有配置。同名玩法也会另建一条，请核对后导入。
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
