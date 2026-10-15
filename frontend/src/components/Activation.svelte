<script lang="ts">
  import { ShieldCheck, LoaderCircle, LogOut } from "lucide-svelte";
  import { api } from "../lib/types";
  export interface LicenseStatus {
    active: boolean;
    server_url?: string;
    binding?: string;
    device?: string;
    expires_at?: number;
    server_time?: number;
    remaining_seconds?: number;
    license_id?: string;
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
  let server = $state("");
  $effect(() => {
    if (!server && status?.server_url) server = status.server_url;
  });
  let code = $state("");
  let migration = $state<{ payload: string; signature: string } | null>(null);
  let pending: { key: string; id: string } | null = null;
  let busy = $state(false);
  let error = $state("");
  async function migrate() {
    if (!migration) return;
    busy = true;
    error = "";
    try {
      await api("/license/migrate", {
        method: "POST",
        body: JSON.stringify({ migration }),
      });
      await onactivated();
    } catch (e) {
      error = e instanceof Error ? e.message : "服务迁移失败";
    } finally {
      busy = false;
    }
  }
  async function activate(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = "";
    try {
      const key = JSON.stringify({ code, server, migration });
      if (!pending || pending.key !== key)
        pending = { key, id: crypto.randomUUID() };
      await api("/license/activate", {
        method: "POST",
        body: JSON.stringify({
          server_url: server,
          code,
          request_id: pending.id,
          migration,
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
        "首次使用需绑定当前设备和管理员账号，授权到期后使用新码续期。"}
    </p>
    <form onsubmit={activate}>
      <label
        >一次性授权码<textarea
          bind:value={code}
          placeholder={status?.hosted
            ? "粘贴运营方为此账号签发的激活码（MSH1 开头）"
            : "粘贴你获得的完整激活码（MSX1 开头）"}
          autocomplete="off"
          maxlength="8192"
          required
          rows="5"
        ></textarea></label
      >
      {#if !status?.hosted}<details class="migration-options">
          <summary>旧码与服务迁移</summary>
          <p class="field-help">
            新版激活码自动携带签名服务地址。仅旧版纯数字字母码需要填写地址；原发现入口失效时可导入签名迁移文件。
          </p>
          <label
            >旧版授权服务地址<input
              type="url"
              bind:value={server}
              placeholder="https://你的授权服务域名"
              autocomplete="url"
            /></label
          >
          <label
            >签名迁移文件<input
              type="file"
              accept="application/json,.json"
              onchange={async (event) => {
                error = "";
                migration = null;
                const file = event.currentTarget.files?.[0];
                if (!file) return;
                try {
                  if (file.size > 16384)
                    throw new Error("迁移文件不能超过 16 KB");
                  const parsed = JSON.parse(await file.text());
                  if (
                    typeof parsed.payload !== "string" ||
                    typeof parsed.signature !== "string"
                  )
                    throw new Error("迁移文件格式无效");
                  migration = {
                    payload: parsed.payload,
                    signature: parsed.signature,
                  };
                } catch (e) {
                  error = e instanceof Error ? e.message : "读取失败";
                }
              }}
            /></label
          >
          {#if migration}<p class="field-help">
              迁移文件已载入，激活时由后端验证签名。
            </p>
            <button
              class="button secondary"
              type="button"
              disabled={busy}
              onclick={migrate}>更新服务地址并重新核验</button
            >{/if}
        </details>{/if}
      <p class="field-help">
        {status?.hosted
          ? "授权绑定当前客户账号，可更换设备。新登录会使旧会话退出。截止日当期可用，过期后已有投注继续结算。"
          : "授权绑定此设备及当前账号密码。更换设备或重置密码后，需要重新授权。时间由授权服务器签名确认；重启必须联网核验，运行期间每分钟复核。"}
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
  input,
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
  .migration-options {
    display: grid;
    gap: 12px;
  }
  summary {
    cursor: pointer;
    padding: 8px 0;
  }
  details label,
  details p {
    margin-top: 12px;
  }
</style>
