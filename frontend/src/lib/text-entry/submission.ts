import type { api as Api } from "../types";
import { textFingerprint } from "./clipboard";

interface Pending {
  id: string;
  fingerprint: string;
}
export function textSubmission(
  account: string,
  api: typeof Api,
  remember: (hash: string) => void,
) {
  const key = `marksix:pending-text:${encodeURIComponent(account)}`;
  function read(): Pending | null {
    let stored;
    try {
      stored = localStorage.getItem(key);
    } catch {
      throw Error("请允许本站存储提交标识后重试");
    }
    if (!stored) return null;
    let value;
    try {
      value = JSON.parse(stored);
    } catch {
      throw Error("待处理提交标识损坏，请先核对投注记录");
    }
    if (
      !/^[a-f0-9-]{36}$/i.test(value.id) ||
      !/^[a-f0-9]{64}$/.test(value.fingerprint)
    )
      throw Error("待处理提交标识损坏，请先核对投注记录");
    return value;
  }
  async function recover() {
    const pending = read();
    if (!pending) return null;
    const receipt = await api<{ id: string | null }>(
      `/slips/submission/${pending.id}`,
    );
    if (!receipt.id) return null;
    remember(pending.fingerprint);
    localStorage.removeItem(key);
    return pending;
  }
  return {
    recover,
    async submit(body: object, raw: string) {
      const fingerprint = await textFingerprint(raw);
      const recorded = await recover();
      if (recorded?.fingerprint === fingerprint) return { replayed: true };
      const previous = read();
      if (previous && previous.fingerprint !== fingerprint)
        throw Error("上一笔提交状态尚未确认，请先用原文重试或核对投注记录");
      const pending = previous ?? { id: crypto.randomUUID(), fingerprint };
      // This write must succeed before sending any financial request.
      try {
        localStorage.setItem(key, JSON.stringify(pending));
      } catch {
        throw Error("请允许本站存储提交标识后重试；本次未提交");
      }
      await api("/slips", {
        method: "POST",
        body: JSON.stringify({ ...body, request_id: pending.id }),
      });
      remember(fingerprint);
      localStorage.removeItem(key);
      return { replayed: false };
    },
  };
}
