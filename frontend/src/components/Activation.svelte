<script lang="ts">
  import { ShieldCheck, LoaderCircle, LogOut } from "lucide-svelte";
  import { api } from "../lib/types";
  export interface LicenseStatus {
    active: boolean;
    expires_at?: number;
    server_time?: number;
    remaining_seconds?: number;
    message?: string;
    testing?: boolean;
    hosted?: boolean;
    permanent?: boolean;
    authorized_through?: string;
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
  let code = $state("");
  let pending: { key: string; id: string } | null = null;
  let busy = $state(false);
  let error = $state("");
  async function activate(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = "";
    try {
      const key = code;
      if (!pending || pending.key !== key)
        pending = { key, id: crypto.randomUUID() };
      await api("/license/activate", {
        method: "POST",
        body: JSON.stringify({
          code,
          request_id: pending.id,
        }),
      });
      code = "";
      pending = null;
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
        "首次使用需激活当前客户账号，授权到期后使用新码续期。"}
    </p>
    <form onsubmit={activate}>
      <label
        >一次性授权码<textarea
          bind:value={code}
          placeholder="粘贴运营方为此账号签发的激活码（MSH1 开头）"
          autocomplete="off"
          maxlength="8192"
          required
          rows="5"
        ></textarea></label
      >
      <p class="field-help">
        授权绑定当前客户账号，可更换设备。新登录会使旧会话退出。截止日当期可用，过期后已有投注继续结算。
      </p>
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
  textarea {
    width: 100%;
    min-height: 46px;
  }
  textarea {
    resize: vertical;
    padding: 12px;
    overflow-wrap: anywhere;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.8);
    color: inherit;
    font: inherit;
  }
</style>
