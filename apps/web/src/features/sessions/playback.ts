import { api } from "../../shared/api/client";
import type { PlaybackEvent, PlaybackHistory } from "../../shared/api/models";

export function orderEvents(events: PlaybackEvent[]) {
  return [...events].sort(
    (a, b) =>
      a.source_seq - b.source_seq ||
      Date.parse(a.observed_at) - Date.parse(b.observed_at) ||
      a.id.localeCompare(b.id),
  );
}
export async function loadHistory(
  id: string,
  previous?: PlaybackHistory,
  signal?: AbortSignal,
): Promise<PlaybackHistory> {
  let cursor = previous?.cursor ?? 0,
    total = previous?.total ?? 0,
    watermark = previous?.watermark ?? 0;
  const byId = new Map(
    (previous?.items ?? []).map((event) => [event.id, event]),
  );
  while (true) {
    signal?.throwIfAborted();
    const page = await api.playback(id, cursor, signal);
    for (const event of page.items) byId.set(event.id, event);
    total = page.total;
    watermark = page.watermark;
    if (page.has_more && page.next_cursor <= cursor)
      throw new Error(
        "Сервер не продвинул курсор истории. Повторите загрузку.",
      );
    cursor = page.next_cursor;
    if (!page.has_more) break;
  }
  return { items: orderEvents([...byId.values()]), total, cursor, watermark };
}
export function eventOffsets(events: PlaybackEvent[]) {
  const origin = Date.parse(events[0]?.observed_at ?? "") || 0;
  let previous = 0;
  return events.map((event) => {
    // A backwards source clock cannot make replay reverse or lose events.
    previous = Math.max(previous, Date.parse(event.observed_at) - origin || 0);
    return previous;
  });
}
export function lastVisible(offsets: number[], position: number) {
  let lo = 0,
    hi = offsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (offsets[mid] <= position) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
export function elapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}
export function safePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safePayload);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /password|passwd|secret|token|credential/i.test(key)
          ? "••••••"
          : safePayload(item),
      ]),
    );
  return value;
}
export function terminalText(value: string) {
  return value
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
      "",
    );
}
