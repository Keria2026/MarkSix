import { expect, test } from "bun:test";
import { recordTransport, type RecordView } from "../../src/lib/collaboration";
import { api } from "../../src/lib/types";
import { createRequestScope } from "../../src/lib/requests";

for (const view of ["shared", "mine", "history"] as RecordView[]) {
  test(`record scope ${view} follows reads, previews and writes without mutating caller headers`, async () => {
    const headers = new Headers({
      "X-MarkSix-Records": "forged",
      "X-Custom": "retained",
    });
    const paths = [
      "/bootstrap",
      "/records/search",
      "/slips/preview",
      "/slips",
      "/periods/2040001/bettor-export",
    ];
    const actual: string[] = [];
    const transport = (async (path: string, options?: RequestInit) => {
      actual.push(path);
      expect(new Headers(options?.headers).get("X-MarkSix-Records")).toBe(view);
      expect(new Headers(options?.headers).get("X-Custom")).toBe("retained");
      expect(options?.body).toBe("{}");
      return { ok: true };
    }) as typeof api;
    const scoped = recordTransport(view, transport);
    for (const path of paths)
      expect(
        await scoped<{ ok: boolean }>(path, { headers, body: "{}" }),
      ).toEqual({ ok: true });
    expect(actual).toEqual(paths);
    expect(headers.get("X-MarkSix-Records")).toBe("forged");
  });
}

test("switching record scope aborts old results even when the transport completes late", async () => {
  let resolve!: (value: unknown) => void;
  const delayed = new Promise<unknown>((r) => (resolve = r));
  const old = createRequestScope(
    () => {},
    recordTransport("shared", (() => delayed) as typeof api),
  );
  const pending = old.api("/records/search");
  old.dispose();
  const mine = createRequestScope(
    () => {},
    recordTransport("mine", (async () => ({ total: 1 })) as typeof api),
  );
  expect(await mine.api<{ total: number }>("/records/search")).toEqual({
    total: 1,
  });
  resolve({ total: 2 });
  await expect(pending).rejects.toThrow();
  mine.dispose();
});
