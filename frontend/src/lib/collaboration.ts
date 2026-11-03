import { api } from "./types";
export type RecordView = "shared" | "mine" | "history";
export interface Collaboration {
  id: string;
  state: string;
  members: { id: string; username: string }[];
}
export interface CustomerSession {
  username: string;
  account_id?: string;
  collaboration?: Collaboration | null;
}
export const recordViews: { id: RecordView; label: string }[] = [
  { id: "shared", label: "协作记录" },
  { id: "mine", label: "仅我录入" },
  { id: "history", label: "关联前记录" },
];
export function recordTransport(
  view: RecordView,
  transport: typeof api = api,
): typeof api {
  return <T>(path: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers);
    headers.set("X-MarkSix-Records", view);
    return transport<T>(path, { ...options, headers });
  };
}
