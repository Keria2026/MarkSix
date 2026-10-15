<script lang="ts">
  import { ShieldCheck, LoaderCircle, LogOut } from "lucide-svelte";
  import { api } from "../lib/types";
  export interface LicenseStatus {
    active: boolean;
    server_url?: string;
    binding?: string;
    device?: string;
    expires_at?: number;
    license_id?: string;
    message?: string;
    testing?: boolean;
  }
  let {
    status,
    onactivated,
    onlogout,
  }: {
    status: LicenseStatus | null;
    onactivated: () => Promise<void>;
    onlogout: () => Promise<void>;
  } = $props();
  let server = $state("");
  $effect(() => {
    if (!server && status?.server_url) server = status.server_url;
  });
  let code = $state("");
  let busy = $state(false);
  let error = $state("");
  async function activate(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = "";
    try {
      await api("/license/activate", {
        method: "POST",
        body: JSON.stringify({ server_url: server, code }),
      });
      code = "";
      await onactivated();
    } catch (e) {
      error = e instanceof Error ? e.message : "激活失败，请重试";
    } finally {
      busy = false;
    }
  }
</script>

<main class="activation-layout">
  <section class="activation-panel glass">
    <div class="brand-mark">M</div>
    <span class="eyebrow">MARKSIX LICENSE</span>
    <h1>激活工作台</h1>
    <p>
      {status?.message ??
        "首次使用需绑定当前设备和管理员账号，授权到期后使用新码续期。"}
    </p>
    <form onsubmit={activate}>
      <label
        >授权服务地址<input
          type="url"
          bind:value={server}
          placeholder="https://你的授权服务域名"
          autocomplete="url"
          required
        /></label
      >
      <label
        >一次性授权码<input
          bind:value={code}
          placeholder="输入提供给你的授权码"
          autocomplete="off"
          maxlength="64"
          required
        /></label
      >
      <p class="field-help">
        授权绑定此设备及当前账号密码。更换设备或重置密码后，需要重新授权。激活后每分钟联网核验授权。
      </p>
      {#if status?.binding}<label
          >授权绑定标识<input
            readonly
            value={status.binding}
            onclick={(e) => e.currentTarget.select()}
          /></label
        >{/if}
      {#if error}<div class="inline-error" role="alert">{error}</div>{/if}
      <button class="button primary" disabled={busy}
        >{#if busy}<LoaderCircle class="spin" size={18} />{:else}<ShieldCheck
            size={18}
          />{/if}激活并进入</button
      >
    </form>
    <button class="button secondary" disabled={busy} onclick={onlogout}
      ><LogOut size={16} />退出账号</button
    >
  </section>
</main>

<style>
  .activation-layout {
    min-height: 100dvh;
    display: grid;
    place-items: center;
    padding: 28px 18px;
  }
  .activation-panel {
    width: min(100%, 520px);
    padding: clamp(24px, 5vw, 44px);
    display: grid;
    gap: 18px;
  }
  h1 {
    margin: 0;
    font-size: 32px;
    letter-spacing: -1px;
  }
  p {
    line-height: 1.65;
    color: var(--text-secondary, #667085);
    margin: 0;
  }
  form {
    display: grid;
    gap: 18px;
  }
  label {
    display: grid;
    gap: 8px;
    font-size: 13px;
    font-weight: 600;
  }
  input {
    width: 100%;
    min-height: 46px;
  }
</style>
