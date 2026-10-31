<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import {
    Activity,
    AlertCircle,
    ArrowRight,
    ArrowUpRight,
    Layers3,
    LoaderCircle,
    LockKeyhole,
    ShieldCheck,
  } from "lucide-svelte";
  import Activation from "./components/Activation.svelte";
  import type { LicenseStatus } from "./components/Activation.svelte";
  import Workspace from "./Workspace.svelte";
  import { ApiError } from "./lib/types";
  import { createRequestScope } from "./lib/requests";

  let username = $state(""),
    password = $state(""),
    loginError = $state("");
  let loggedIn = $state(false),
    loading = $state(true),
    busy = $state(false);
  let licenseStatus = $state<LicenseStatus | null>(null);
  let epoch = $state(0);
  let requests = createRequestScope(invalid);
  let checking = false;

  function reset() {
    requests.dispose();
    requests = createRequestScope(invalid);
    epoch++;
    loggedIn = false;
    licenseStatus = null;
    password = "";
    checking = false;
  }
  function invalid(status: number) {
    if (status === 401 && loggedIn) {
      reset();
      loginError = "登录已失效，请重新登录";
    } else if (status === 402) {
      // Destroy all business state immediately; renewal starts a fresh workspace.
      licenseStatus = null;
      void refreshLicense();
    }
  }
  async function refreshLicense() {
    if (!loggedIn || checking) return !!licenseStatus?.active;
    checking = true;
    const attempt = epoch;
    try {
      const status = await requests.api<LicenseStatus>("/license");
      if (attempt === epoch) licenseStatus = status;
      return attempt === epoch && status.active;
    } catch (e) {
      if (
        attempt === epoch &&
        !(e instanceof DOMException && e.name === "AbortError")
      )
        loginError = e instanceof Error ? e.message : "授权检查失败，请重试";
    } finally {
      if (attempt === epoch) checking = false;
    }
    return false;
  }
  async function signIn(event: SubmitEvent) {
    event.preventDefault();
    const credentials = { username, password };
    reset();
    const attempt = epoch;
    busy = true;
    loginError = "";
    try {
      await requests.api("/login", {
        method: "POST",
        body: JSON.stringify(credentials),
      });
      if (attempt !== epoch) return;
      password = "";
      loggedIn = true;
      await refreshLicense();
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError"))
        loginError = e instanceof Error ? e.message : "登录失败，请重试";
    } finally {
      busy = false;
    }
  }
  async function signOut() {
    // Keep logout independent while immediately destroying the account scope.
    const logout = createRequestScope(() => {});
    reset();
    busy = true;
    try {
      await logout.api("/logout", { method: "POST", body: "{}" });
    } catch {
      loginError = "退出请求未完成，请重试或关闭页面";
    } finally {
      logout.dispose();
      busy = false;
    }
  }
  onDestroy(() => requests.dispose());
  onMount(() => {
    const attempt = epoch;
    void (async () => {
      try {
        const session = await requests.api<{ username: string }>("/session");
        if (attempt !== epoch) return;
        username = session.username;
        loggedIn = true;
        await refreshLicense();
      } catch (e) {
        if (
          !(e instanceof ApiError && e.status === 401) &&
          !(e instanceof DOMException && e.name === "AbortError")
        )
          loginError = e instanceof Error ? e.message : "无法连接服务";
      } finally {
        loading = false;
      }
    })();
    const poll = setInterval(() => {
      if (!document.hidden) void refreshLicense();
    }, 6000);
    return () => clearInterval(poll);
  });
</script>

<svelte:head
  ><title>{loggedIn ? "MarkSix" : "登录 · MarkSix"}</title></svelte:head
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
            />正在登录{:else}进入工作台<ArrowRight size={17} />{/if}</button
        >
      </form>
    </section>
  </main>
{:else if licenseStatus === null}
  <main class="initial-loading">
    <section class="empty-panel glass" aria-live="polite">
      <h1>正在检查账号授权</h1>
      {#if loginError}<p class="inline-error" role="alert">
          {loginError}
        </p>{:else}<LoaderCircle class="spin" size={22} />{/if}
      <button class="button secondary" onclick={refreshLicense}>重新检查</button
      ><button class="text-button" onclick={signOut}>退出账号</button>
    </section>
  </main>
{:else if !licenseStatus.active}
  {#key epoch}<Activation
      status={licenseStatus}
      onactivated={async () => {
        await refreshLicense();
      }}
      onlogout={signOut}
      oninvalid={invalid}
    />{/key}
{:else}
  {#key epoch}<Workspace
      {username}
      {licenseStatus}
      onlogout={signOut}
      oninvalid={invalid}
      onrefreshlicense={refreshLicense}
    />{/key}
{/if}
