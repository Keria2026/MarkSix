import { api, ApiError } from "./types";

// One scope per mounted account view. Disposed requests cannot mutate a later
// account, even if a transport completes after cancellation.
export function createRequestScope(
  oninvalid: (status: number) => void,
  transport: typeof api = api,
) {
  const lifetime = new AbortController();
  return {
    dispose: () => lifetime.abort(),
    async api<T>(path: string, options: RequestInit = {}): Promise<T> {
      const controller = new AbortController();
      const abort = () => controller.abort();
      const signals = [lifetime.signal, options.signal].filter(
        (signal): signal is AbortSignal => signal != null,
      );
      for (const signal of signals) {
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }
      try {
        controller.signal.throwIfAborted();
        const result = await transport<T>(path, {
          ...options,
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        return result;
      } catch (error) {
        controller.signal.throwIfAborted();
        if (error instanceof ApiError && [401, 402].includes(error.status))
          oninvalid(error.status);
        throw error;
      } finally {
        for (const signal of signals)
          signal.removeEventListener("abort", abort);
      }
    },
  };
}
