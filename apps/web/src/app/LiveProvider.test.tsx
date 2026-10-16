import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { api } from "../shared/api/client";
import { LiveProvider } from "./LiveProvider";
const auth = vi.hoisted(() => ({ user: { username: "operator" } }));
vi.mock("../features/auth/Auth", () => ({ useAuth: () => auth }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("live artifact refresh", () => {
  it("invalidates artifacts on artifact.changed and reconnection", async () => {
    const listeners = new Map<string, (event: MessageEvent) => void>();
    let stream: { onopen?: () => void; close: () => void } | undefined;
    class FakeStream {
      onopen?: () => void;
      close = vi.fn();
      constructor() {
        stream = this;
      }
      addEventListener(kind: string, fn: (event: MessageEvent) => void) {
        listeners.set(kind, fn);
      }
    }
    vi.stubGlobal("EventSource", FakeStream);
    vi.spyOn(api, "events").mockResolvedValue({
      items: [],
      total: 0,
      watermark: 1,
    } as never);
    const client = new QueryClient(),
      invalidate = vi.spyOn(client, "invalidateQueries");
    render(
      <QueryClientProvider client={client}>
        <LiveProvider>
          <div>Workspace</div>
        </LiveProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(stream?.onopen).toBeDefined());
    stream!.onopen!();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["artifacts"] });
    invalidate.mockClear();
    listeners.get("update")!(
      new MessageEvent("update", {
        data: JSON.stringify({ kind: "artifact.changed", id: "artifact" }),
      }),
    );
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith(
        { queryKey: ["artifacts"] },
        { cancelRefetch: false },
      ),
    );
  });
  it("allows an in-flight history refresh to finish under repeated live updates", async () => {
    const listeners = new Map<string, (e: MessageEvent) => void>();
    class FakeStream {
      close = vi.fn();
      addEventListener(kind: string, fn: (e: MessageEvent) => void) {
        listeners.set(kind, fn);
      }
    }
    vi.stubGlobal("EventSource", FakeStream);
    vi.spyOn(api, "events").mockResolvedValue({
      items: [],
      total: 0,
      watermark: 1,
    } as never);
    const aborted = vi.fn();
    let finish!: (n: number) => void;
    const read = vi
      .fn()
      .mockResolvedValueOnce(1)
      .mockImplementation(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise<number>((resolve, reject) => {
            finish = resolve;
            signal.addEventListener("abort", () => {
              aborted();
              reject(new Error("aborted"));
            });
          }),
      );
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      }),
      invalidate = vi.spyOn(client, "invalidateQueries");
    function History() {
      const q = useQuery({ queryKey: ["playback", "s"], queryFn: read });
      return <div>History {q.data}</div>;
    }
    render(
      <QueryClientProvider client={client}>
        <LiveProvider>
          <History />
        </LiveProvider>
      </QueryClientProvider>,
    );
    await screen.findByText("History 1");
    await waitFor(() => expect(listeners.has("update")).toBe(true));
    const emit = () =>
      listeners.get("update")!(
        new MessageEvent("update", {
          data: JSON.stringify({ kind: "event.created" }),
        }),
      );
    emit();
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    emit();
    await waitFor(() =>
      expect(
        invalidate.mock.calls.filter((c) => c[0]?.queryKey?.[0] === "playback"),
      ).toHaveLength(2),
    );
    expect(read).toHaveBeenCalledTimes(2);
    expect(aborted).not.toHaveBeenCalled();
    finish(2);
    await screen.findByText("History 2");
  });
});
