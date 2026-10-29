<script lang="ts">
  import { site } from "./lib/site";
  import { onMount, onDestroy } from "svelte";
  import { pageFade } from "./lib/navigation";
  import {
    Users,
    KeyRound,
    ShieldCheck,
    History,
    Plus,
    Search,
    LogOut,
    LoaderCircle,
    RefreshCw,
    Copy,
    AlertTriangle,
  } from "lucide-svelte";
  import { createRequestScope } from "./lib/requests";
  import Modal from "./components/Modal.svelte";
  function invalid(status: number) {
    if (status === 401 && loggedIn) resetAccount();
  }
  let requests = createRequestScope(invalid);
  async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
    return requests.api<T>(path, options);
  }
  onDestroy(() => requests.dispose());
  function resetAccount() {
    requests.dispose();
    requests = createRequestScope(invalid);
    loggedIn = false;
    customers = [];
    codes = [];
    events = [];
    admins = [];
    password = "";
    operator = "";
    search = "";
    tab = "accounts";
    target = null;
    dialog = null;
    newName = "";
    newPassword = "";
    issuedCode = "";
    confirmation = "";
    action = "";
    notice = "";
    modalError = "";
    permanent = false;
    days = 30;
    redeemDate = "";
  }
  interface Customer {
    id: string;
    username: string;
    permanent: boolean;
    authorized_through: string | null;
    disabled: boolean;
    state: string;
    active: boolean;
  }
  interface Code {
    id: string;
    username: string;
    days: number;
    redeem_through: string;
    redeemed_at: string | null;
    granted_through: string | null;
    revoked_at: string | null;
  }
  interface Audit {
    id: number;
    administrator_id: string | null;
    account_id: string | null;
    event: string;
    created_at: string;
  }
  type Tab = "accounts" | "codes" | "administrators" | "audit";
  let tab = $state<Tab>("accounts");
  let loading = $state(true),
    loggedIn = $state(false),
    busy = $state(false);
  let name = $state(""),
    password = $state(""),
    operator = $state(""),
    error = $state(""),
    notice = $state(""),
    search = $state("");
  let customers = $state<Customer[]>([]),
    codes = $state<Code[]>([]),
    admins = $state<{ id: string; username: string }[]>([]),
    events = $state<Audit[]>([]);
  let dialog = $state<
    | "create"
    | "password"
    | "rename"
    | "code"
    | "delete"
    | "administrator"
    | "confirm"
    | null
  >(null);
  let target = $state<Customer | null>(null),
    newName = $state(""),
    newPassword = $state(""),
    permanent = $state(false),
    days = $state(30),
    redeemDate = $state(""),
    confirmation = $state(""),
    action = $state(""),
    modalError = $state(""),
    issuedCode = $state("");
  const tabs = [
    { id: "accounts" as const, label: "客户管理", icon: Users },
    { id: "codes" as const, label: "激活码", icon: KeyRound },
    { id: "administrators" as const, label: "管理员", icon: ShieldCheck },
    { id: "audit" as const, label: "操作日志", icon: History },
  ];
  const names: Record<string, string> = {
    create_account: "创建客户",
    issue_code: "签发激活码",
    redeem_code: "客户激活或续期",
    disable: "停用客户",
    enable: "启用客户",
    password_reset: "修改客户密码",
    username_changed: "修改客户账号",
    permanent_changed: "修改永久授权",
    authorization_revoked: "撤销授权",
    revoke_code: "作废激活码",
    create_administrator: "创建管理员",
    permanent_delete_completed: "永久删除完成",
  };
  const filtered = $derived(
    customers.filter((c) =>
      c.username.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
    ),
  );
  function status(c: Customer) {
    return c.state === "deleting"
      ? "删除中，可重试"
      : c.state === "failed"
        ? "初始化失败"
        : c.state !== "ready"
          ? "初始化中"
          : c.disabled
            ? "已停用"
            : c.permanent
              ? "永久授权"
              : c.active
                ? "已授权"
                : "待激活 / 已到期";
  }
  function open(
    kind: typeof dialog,
    c: Customer | null = null,
    nextAction = "",
  ) {
    target = c;
    dialog = kind;
    newName = kind === "rename" ? (c?.username ?? "") : "";
    newPassword = "";
    permanent = false;
    days = 30;
    confirmation = "";
    modalError = "";
    issuedCode = "";
    action = nextAction;
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 30);
    redeemDate = d.toISOString().slice(0, 10);
  }
  async function refresh() {
    error = "";
    try {
      if (tab === "accounts")
        customers = (await api<{ items: Customer[] }>("/accounts")).items;
      if (tab === "codes")
        codes = (await api<{ items: Code[] }>("/codes")).items;
      if (tab === "administrators")
        admins = (
          await api<{ items: { id: string; username: string }[] }>(
            "/administrators",
          )
        ).items;
      if (tab === "audit")
        events = (await api<{ items: Audit[] }>("/audit")).items;
    } catch (e) {
      error = e instanceof Error ? e.message : "加载失败";
    }
  }
  async function login(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = "";
    try {
      await api("/login", {
        method: "POST",
        body: JSON.stringify({ username: name, password }),
      });
      password = "";
      operator = name;
      loggedIn = true;
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : "登录失败";
    } finally {
      busy = false;
    }
  }
  async function logout() {
    const logout = createRequestScope(() => {});
    resetAccount();
    busy = true;
    try {
      await logout.api("/logout", { method: "POST" });
    } catch {
      error = "退出请求未完成，请重试或关闭页面";
    } finally {
      logout.dispose();
      busy = false;
    }
  }
  async function save(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    modalError = "";
    try {
      if (dialog === "create")
        await api("/accounts", {
          method: "POST",
          body: JSON.stringify({
            username: newName,
            password: newPassword,
            permanent,
          }),
        });
      if (dialog === "administrator")
        await api("/administrators", {
          method: "POST",
          body: JSON.stringify({ username: newName, password: newPassword }),
        });
      if (dialog === "rename" && target)
        await api(`/accounts/${target.id}`, {
          method: "PUT",
          body: JSON.stringify({ action: "rename", username: newName }),
        });
      if (dialog === "password" && target)
        await api(`/accounts/${target.id}`, {
          method: "PUT",
          body: JSON.stringify({ action: "password", password: newPassword }),
        });
      if (dialog === "code" && target) {
        const result = await api<{ code: string }>(
          `/accounts/${target.id}/codes`,
          {
            method: "POST",
            body: JSON.stringify({
              days: Number(days),
              redeem_through: redeemDate,
            }),
          },
        );
        issuedCode = result.code;
        newPassword = "";
        return;
      }
      if (dialog === "delete" && target)
        await api(`/accounts/${target.id}`, {
          method: "PUT",
          body: JSON.stringify({ action: "delete", confirmation }),
        });
      if (dialog === "confirm" && target)
        await api(`/accounts/${target.id}`, {
          method: "PUT",
          body: JSON.stringify(
            action === "permanent"
              ? { action, enabled: !target.permanent }
              : { action },
          ),
        });
      newPassword = "";
      dialog = null;
      notice = "操作已完成";
      await refresh();
    } catch (e) {
      modalError = e instanceof Error ? e.message : "操作失败";
      if (dialog === "create") await refresh();
    } finally {
      busy = false;
    }
  }
  async function retry(c: Customer) {
    busy = true;
    try {
      await api(`/accounts/${c.id}/provision`, { method: "POST" });
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : "初始化失败";
    } finally {
      busy = false;
    }
  }
  async function revoke(c: Code) {
    busy = true;
    try {
      await api(`/codes/${c.id}/revoke`, { method: "POST" });
      await refresh();
    } catch (e) {
      error = e instanceof Error ? e.message : "作废失败";
    } finally {
      busy = false;
    }
  }
  onMount(() => {
    void (async () => {
      try {
        operator = (await api<{ username: string }>("/session")).username;
        loggedIn = true;
        await refresh();
      } catch {
        loggedIn = false;
      } finally {
        loading = false;
      }
    })();
  });
</script>

<svelte:head
  ><title
    >{loggedIn ? tabs.find((t) => t.id === tab)?.label : "登录"} · auth 管理端</title
  ></svelte:head
>

{#if loading}<main class="owner-loading" aria-live="polite">
    <LoaderCircle class="spin" />正在连接管理后台
  </main>
{:else if !loggedIn}<main class="owner-login">
    <section class="glass">
      <div class="brand-mark">M</div>
      <p class="eyebrow">AUTH · {site.version}</p>
      <h1>auth 管理端</h1>

      <form onsubmit={login}>
        <label
          >管理员账号<input
            bind:value={name}
            autocomplete="username"
            required
            maxlength="80"
          /></label
        ><label
          >密码<input
            bind:value={password}
            type="password"
            autocomplete="current-password"
            required
            maxlength="256"
          /></label
        >{#if error}<p class="inline-error" role="alert">{error}</p>{/if}<button
          class="button primary"
          disabled={busy}
          >{#if busy}<LoaderCircle
              class="spin"
              size={18}
            />{/if}登录管理后台</button
        >
      </form>
    </section>
  </main>
{:else}<div class="owner-layout">
    <aside class="glass">
      <a class="owner-brand" href="/"
        ><div class="brand-mark">a</div>
        <span>auth <small>管理端</small></span></a
      >
      <nav aria-label="管理导航">
        {#each tabs as item}<button
            class:chosen={tab === item.id}
            aria-current={tab === item.id ? "page" : undefined}
            onclick={async () => {
              tab = item.id;
              notice = "";
              await refresh();
            }}><item.icon size={19} />{item.label}</button
          >{/each}
      </nav>
      <div class="owner-account">
        <span>{operator}</span><button
          class="icon-button"
          disabled={busy}
          onclick={logout}
          aria-label="退出管理后台"><LogOut size={19} /></button
        >
      </div>
    </aside>
    <main class="owner-main" use:pageFade={tab}>
      <header>
        <div>
          <p class="eyebrow">AUTH · {site.version}</p>
          <h1>{tabs.find((t) => t.id === tab)?.label}</h1>
        </div>
        <button class="button secondary" disabled={busy} onclick={refresh}
          ><RefreshCw size={16} />刷新</button
        >
      </header>
      {#if error}<p class="inline-error" role="alert">
          {error}
        </p>{/if}{#if notice}<p class="owner-notice" role="status">
          {notice}
        </p>{/if}
      {#if tab === "accounts"}<section class="glass owner-panel">
          <div class="owner-toolbar">
            <label class="owner-search"
              ><Search size={17} /><input
                aria-label="搜索客户账号"
                placeholder="搜索客户账号"
                bind:value={search}
              /></label
            ><button class="button primary" onclick={() => open("create")}
              ><Plus size={17} />新增客户</button
            >
          </div>

          <div class="owner-grid">
            {#each filtered as c}<article class="owner-card">
                <div class="owner-card-head">
                  <h2>{c.username}</h2>
                  <span class="soft-chip">{status(c)}</span>
                </div>
                <p class="owner-muted">
                  {c.permanent
                    ? "永久授权"
                    : `授权至 ${c.authorized_through ?? "尚未激活"}`}
                </p>
                <div class="owner-actions">
                  {#if c.state === "failed"}<button
                      class="button secondary"
                      disabled={busy}
                      onclick={() => retry(c)}>重试初始化</button
                    >{/if}
                  <button
                    class="button secondary"
                    disabled={c.state !== "ready" || c.disabled || c.permanent}
                    onclick={() => open("code", c)}>签发激活码</button
                  >
                  <button
                    class="button secondary"
                    disabled={c.state === "deleting"}
                    onclick={() => open("rename", c)}>修改账号</button
                  >
                  <button
                    class="button secondary"
                    disabled={c.state === "deleting"}
                    onclick={() => open("password", c)}>修改密码</button
                  >
                  <button
                    class="button secondary"
                    disabled={c.state === "deleting"}
                    onclick={() =>
                      open("confirm", c, c.disabled ? "enable" : "disable")}
                    >{c.disabled ? "启用" : "停用"}</button
                  >
                  <button
                    class="button secondary"
                    disabled={c.state === "deleting"}
                    onclick={() => open("confirm", c, "permanent")}
                    >{c.permanent ? "取消永久授权" : "设为永久授权"}</button
                  >
                  <button
                    class="button secondary"
                    disabled={c.state === "deleting"}
                    onclick={() => open("confirm", c, "revoke")}
                    >撤销授权</button
                  >
                  <button
                    class="button owner-danger"
                    onclick={() => open("delete", c)}>永久删除</button
                  >
                </div>
              </article>{:else}<p class="owner-empty">
                {search ? "没有匹配的客户" : "尚无客户，点击新增客户开始。"}
              </p>{/each}
          </div>
        </section>
      {:else if tab === "codes"}<section class="glass owner-panel">
          <div class="owner-table">
            <table>
              <caption class="sr-only">激活码记录</caption><thead
                ><tr
                  ><th>客户</th><th>授权天数</th><th>激活截止日</th><th>状态</th
                  ><th>激活后授权至</th><th>操作</th></tr
                ></thead
              ><tbody
                >{#each codes as c}<tr
                    ><td>{c.username}</td><td>{c.days} 天</td><td
                      >{c.redeem_through}</td
                    ><td
                      >{c.revoked_at
                        ? "已作废"
                        : c.redeemed_at
                          ? "已使用"
                          : c.redeem_through <
                              new Intl.DateTimeFormat("en-CA", {
                                timeZone: "Asia/Shanghai",
                                year: "numeric",
                                month: "2-digit",
                                day: "2-digit",
                              }).format(new Date())
                            ? "已过期"
                            : "待使用"}</td
                    ><td>{c.granted_through ?? "—"}</td><td
                      ><button
                        class="button secondary"
                        disabled={busy || !!c.redeemed_at || !!c.revoked_at}
                        onclick={() => revoke(c)}>作废</button
                      ></td
                    ></tr
                  >{:else}<tr><td colspan="6">暂无激活码</td></tr>{/each}</tbody
              >
            </table>
          </div>
        </section>
      {:else if tab === "administrators"}<section class="glass owner-panel">
          <div class="owner-toolbar">
            <button class="button primary" onclick={() => open("administrator")}
              ><Plus size={17} />新增管理员</button
            >
          </div>
          <div class="owner-grid">
            {#each admins as a}<article class="owner-card">
                <ShieldCheck size={21} />
                <h2>{a.username}</h2>
                <p class="owner-muted">超级管理员</p>
              </article>{/each}
          </div>
        </section>
      {:else}<section class="glass owner-panel">
          <div class="owner-table">
            <table>
              <caption class="sr-only">后台操作日志</caption><thead
                ><tr
                  ><th>时间（UTC）</th><th>操作</th><th>操作者编号</th><th
                    >客户编号</th
                  ></tr
                ></thead
              ><tbody
                >{#each events as e}<tr
                    ><td>{e.created_at.replace("T", " ")}</td><td
                      >{names[e.event] ?? e.event}</td
                    ><td>{e.administrator_id ?? "客户"}</td><td
                      >{e.account_id ?? "—"}</td
                    ></tr
                  >{:else}<tr><td colspan="4">暂无操作记录</td></tr
                  >{/each}</tbody
              >
            </table>
          </div>
        </section>{/if}
    </main>
  </div>{/if}

{#if dialog}<Modal
    dismissible={!busy}
    title={dialog === "rename"
      ? "修改客户账号"
      : dialog === "create"
        ? "新增客户"
        : dialog === "administrator"
          ? "新增后台管理员"
          : dialog === "password"
            ? "修改客户密码"
            : dialog === "code"
              ? "签发激活码"
              : dialog === "delete"
                ? "永久删除客户"
                : "确认授权变更"}
    onclose={() => {
      if (!busy) {
        dialog = null;
        issuedCode = "";
        newPassword = "";
      }
    }}
  >
    {#if issuedCode}<div class="owner-code">
        <ShieldCheck size={28} />
        <h3>激活码已生成</h3>
        <p>
          仅此一次显示，请复制并安全交给 {target?.username}。关闭后无法找回原文。
        </p>
        <label
          >完整激活码<textarea
            readonly
            value={issuedCode}
            rows="4"
            onclick={(e) => e.currentTarget.select()}
          ></textarea></label
        ><button
          class="button primary"
          onclick={async () => {
            try {
              await navigator.clipboard.writeText(issuedCode);
              modalError = "已复制";
            } catch {
              modalError = "请选中并手工复制激活码";
            }
          }}><Copy size={17} />复制激活码</button
        >{#if modalError}<p role="status">{modalError}</p>{/if}
      </div>
    {:else}<form class="owner-form" onsubmit={save}>
        {#if target}<p>客户：<strong>{target.username}</strong></p>{/if}
        {#if dialog === "create" || dialog === "administrator" || dialog === "rename"}<label
            >账号<input
              bind:value={newName}
              autocomplete="off"
              maxlength="80"
              required
            /></label
          >{/if}
        {#if dialog === "create" || dialog === "administrator" || dialog === "password"}<label
            >{dialog === "password" ? "新密码" : "初始密码"}<input
              type="password"
              bind:value={newPassword}
              autocomplete="new-password"
              minlength="12"
              maxlength="256"
              required
            /></label
          >
        {/if}
        {#if dialog === "create"}<label class="owner-checkbox"
            ><input type="checkbox" bind:checked={permanent} />永久授权</label
          >{/if}
        {#if dialog === "code"}<label
            >授权天数<input
              type="number"
              min="1"
              max="3650"
              step="1"
              bind:value={days}
              required
            /></label
          ><label
            >激活截止日（北京时间，含当天）<input
              type="date"
              bind:value={redeemDate}
              required
            /></label
          >
        {/if}
        {#if dialog === "password" || dialog === "rename"}<p
            class="owner-muted"
          >
            剩余授权保留，所有旧会话退出，未使用的旧激活码作废。
          </p>{/if}
        {#if dialog === "confirm"}<p class="owner-muted">
            {action === "disable"
              ? "停用后客户无法登录，已有投注仍会结算。"
              : action === "enable"
                ? "重新允许客户登录；有效期保持不变。"
                : action === "revoke"
                  ? "立即撤销当前授权并作废未使用激活码。客户需要新码再次激活，已有投注继续结算。"
                  : target?.permanent
                    ? "取消永久授权后按原截止日校验，若原本没有期限则需激活。"
                    : "设置后不再受到授权到期限制，业务规则照常生效。"}所有旧会话将退出。
          </p>{/if}
        {#if dialog === "delete"}<div class="inline-error">
            <AlertTriangle
              size={19}
            />将永久删除账号、全部账本、玩法、激活码以及服务器管理的相关备份，无法撤销。服务器外由你另行保存的副本需要你自行删除。
          </div>
          <label
            >请输入“永久删除 {target?.username}”<input
              bind:value={confirmation}
              autocomplete="off"
              required
            /></label
          >{/if}
        {#if modalError}<p class="inline-error" role="alert">
            {modalError}
          </p>{/if}
        <div class="owner-actions">
          <button
            class="button secondary"
            type="button"
            disabled={busy}
            onclick={() => {
              dialog = null;
              newPassword = "";
            }}>取消</button
          ><button
            class="button"
            class:primary={dialog !== "delete"}
            class:owner-danger={dialog === "delete"}
            disabled={busy ||
              (dialog === "delete" &&
                confirmation !== `永久删除 ${target?.username}`)}
            >{#if busy}<LoaderCircle class="spin" size={17} />{/if}{dialog ===
            "delete"
              ? "永久删除全部资料"
              : dialog === "code"
                ? "生成一次性激活码"
                : "确认"}</button
          >
        </div>
      </form>{/if}
  </Modal>{/if}

<style>
  .owner-loading,
  .owner-login {
    min-height: 100dvh;
    display: grid;
    place-content: center;
    padding: 24px;
    gap: 16px;
  }
  .owner-login section {
    padding: 36px;
    width: min(430px, calc(100vw - 40px));
    border-radius: 28px;
  }
  .owner-login form,
  .owner-form {
    display: grid;
    gap: 18px;
  }
  .owner-login h1 {
    font-size: 30px;
    letter-spacing: -1px;
  }
  .owner-muted {
    color: var(--muted);
    line-height: 1.7;
  }
  .owner-layout {
    display: grid;
    grid-template-columns: 220px minmax(0, 1fr);
    min-height: 100dvh;
    gap: 24px;
    padding: 20px;
  }
  .owner-layout aside {
    position: sticky;
    top: 20px;
    height: calc(100dvh - 40px);
    padding: 24px 14px;
    border-radius: 26px;
    display: flex;
    flex-direction: column;
  }
  .owner-brand {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 4px 12px 26px;
    font-size: 28px;
    font-weight: 750;
  }
  .owner-brand span {
    font-size: 19px;
  }
  .owner-brand small {
    display: block;
    font-size: 12px;
    color: var(--muted);
    font-weight: 500;
    margin-top: 5px;
  }
  .owner-layout nav {
    display: grid;
    gap: 7px;
  }
  .owner-layout nav button {
    display: flex;
    align-items: center;
    gap: 12px;
    background: transparent;
    min-height: 48px;
    padding: 12px 15px;
    text-align: left;
    border-radius: 14px;
  }
  .owner-layout nav .chosen {
    color: var(--blue);
    background: #e8effc;
    font-weight: 650;
  }
  .owner-account {
    margin-top: auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px;
    overflow-wrap: anywhere;
  }
  .owner-main {
    min-width: 0;
    padding: 16px 12px 30px;
  }
  .owner-main header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 18px;
    margin-bottom: 24px;
  }
  .owner-main h1 {
    font-size: 34px;
    letter-spacing: -1.2px;
    margin: 8px 0;
  }
  .owner-panel {
    padding: 24px;
    border-radius: 24px;
  }
  .owner-toolbar {
    display: flex;
    gap: 16px;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
  }
  .owner-search {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 10px;
    max-width: 360px;
    flex: 1;
    min-width: 160px;
  }
  .owner-search input {
    min-width: 0;
  }
  .owner-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr));
    gap: 16px;
    margin-top: 20px;
  }
  .owner-card {
    border: 1px solid var(--line);
    border-radius: 20px;
    padding: 21px;
    background: rgba(255, 255, 255, 0.5);
    min-width: 0;
  }
  .owner-card h2 {
    font-size: 19px;
    margin: 0;
    overflow-wrap: anywhere;
  }
  .owner-card-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .owner-actions {
    display: flex;
    gap: 9px;
    flex-wrap: wrap;
  }
  .owner-actions .button {
    min-height: 44px;
  }
  .owner-danger {
    background: #fbe9eb;
    color: #9d2536;
    border: 1px solid #e9bdc4;
  }
  .owner-notice {
    padding: 12px 16px;
    border-radius: 14px;
    background: #e4f3ec;
    color: #18543f;
  }
  .owner-table {
    overflow: auto;
    max-width: 100%;
    margin-top: 16px;
  }
  .owner-table table {
    width: 100%;
    border-collapse: collapse;
    text-align: left;
    white-space: nowrap;
  }
  .owner-table th,
  .owner-table td {
    padding: 15px 12px;
    border-bottom: 1px solid var(--line);
    font-size: 13px;
  }
  .owner-table th {
    color: var(--muted);
    font-weight: 600;
  }
  .owner-empty {
    padding: 25px 0;
    color: var(--muted);
  }
  .owner-checkbox {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .owner-checkbox input {
    width: 20px;
    height: 20px;
  }
  .owner-code {
    display: grid;
    gap: 14px;
    line-height: 1.7;
  }
  .owner-code textarea {
    font-family: ui-monospace, monospace;
    word-break: break-all;
  }
  .owner-form .inline-error {
    line-height: 1.7;
    padding: 14px;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  @media (max-width: 760px) {
    .owner-layout {
      grid-template-columns: 1fr;
      gap: 12px;
      padding: 12px;
    }
    .owner-layout aside {
      position: static;
      height: auto;
      padding: 12px;
      border-radius: 20px;
    }
    .owner-brand {
      padding: 5px 8px 14px;
    }
    .owner-layout nav {
      grid-template-columns: repeat(4, 1fr);
      gap: 4px;
    }
    .owner-layout nav button {
      flex-direction: column;
      gap: 5px;
      justify-content: center;
      text-align: center;
      font-size: 12px;
      padding: 9px 3px;
    }
    .owner-account {
      padding: 8px 5px 0;
    }
    .owner-main {
      padding: 8px 0;
    }
    .owner-main h1 {
      font-size: 28px;
    }
    .owner-panel {
      padding: 16px;
    }
    .owner-card {
      padding: 17px;
    }
    .owner-toolbar > .button {
      width: 100%;
    }
  }
  .owner-main header > div,
  .owner-toolbar > *,
  .owner-form,
  .owner-form label {
    min-width: 0;
  }
  .owner-form input:not([type="checkbox"]),
  .owner-search input,
  .owner-code textarea {
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }
  .owner-actions .button {
    min-width: 0;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .owner-form .owner-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .owner-form .owner-actions .button {
    width: 100%;
    min-width: 0;
    white-space: normal;
  }
  @media (max-width: 600px) {
    .owner-main header {
      flex-wrap: wrap;
      gap: 12px;
    }
    .owner-main header > div {
      flex: 1 1 180px;
    }
    .owner-search {
      flex-basis: 100%;
      max-width: none;
    }
    .owner-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      width: 100%;
    }
    .owner-actions .button {
      width: 100%;
      padding: 10px 8px;
    }
    .owner-card-head .soft-chip {
      max-width: 100%;
      white-space: normal;
    }
    .owner-login {
      padding: 16px;
    }
    .owner-login section {
      padding: 24px;
      width: min(430px, calc(100vw - 32px));
    }
  }
</style>
