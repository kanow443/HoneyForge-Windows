import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../shared/api/client";
import {
  eventOffsets,
  lastVisible,
  loadHistory,
  orderEvents,
  safePayload,
  terminalText,
} from "./playback";
import { event } from "./playback.fixtures";
afterEach(() => vi.restoreAllMocks());
describe("durable playback history", () => {
  it("loads every cursor page, deduplicates and orders by source sequence rather than ingestion", async () => {
    const fetch = vi
      .spyOn(api, "playback")
      .mockResolvedValueOnce({
        items: [event("second", 2)],
        total: 3,
        next_cursor: 20,
        watermark: 50,
        has_more: true,
      })
      .mockResolvedValueOnce({
        items: [event("first", 1), event("third", 3)],
        total: 3,
        next_cursor: 50,
        watermark: 50,
        has_more: false,
      });
    const loaded = await loadHistory("s");
    expect(fetch.mock.calls.map((c) => c[1])).toEqual([0, 20]);
    expect(loaded.items.map((e) => e.id)).toEqual(["first", "second", "third"]);
    expect(loaded.cursor).toBe(50);
    fetch.mockResolvedValueOnce({
      items: [event("third", 3), event("fourth", 4)],
      total: 4,
      next_cursor: 60,
      watermark: 60,
      has_more: false,
    });
    const resumed = await loadHistory("s", loaded);
    expect(resumed.items.map((e) => e.id)).toEqual([
      "first",
      "second",
      "third",
      "fourth",
    ]);
    expect(fetch.mock.calls[2][1]).toBe(50);
  });
  it("rejects a stuck cursor instead of falsely declaring full history", async () => {
    vi.spyOn(api, "playback").mockResolvedValue({
      items: [],
      total: 10,
      next_cursor: 0,
      watermark: 10,
      has_more: true,
    });
    await expect(loadHistory("s")).rejects.toThrow("курсор");
  });
  it("aborts without publishing a partial page", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.spyOn(api, "playback");
    await expect(
      loadHistory("s", undefined, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps replay time monotonic across source clock corrections and same-time events", () => {
    const events = orderEvents([
      event("third", 3, 8000),
      event("first", 1, 5000),
      event("second", 2, 4000),
      event("fourth", 4, 8000),
    ]);
    const offsets = eventOffsets(events);
    expect(offsets).toEqual([0, 0, 3000, 3000]);
    expect(lastVisible(offsets, 0)).toBe(2);
    expect(lastVisible(offsets, 2999)).toBe(2);
    expect(lastVisible(offsets, 3000)).toBe(4);
  });
  it("removes ANSI/OSC controls and masks nested credentials without changing the original", () => {
    expect(
      terminalText(
        "\x1b[31mcat\x1b[0m\x1b]8;;https://evil\x07file\x1b]8;;\x07",
      ),
    ).toBe("catfile");
    expect(terminalText("safe\x1b]malformed")).toBe("safe");
    const payload = {
      username: "operator",
      password: "secret",
      nested: [{ access_token: "token", command: "hostname" }],
    };
    expect(safePayload(payload)).toEqual({
      username: "operator",
      password: "••••••",
      nested: [{ access_token: "••••••", command: "hostname" }],
    });
    expect(payload.password).toBe("secret");
  });
});
