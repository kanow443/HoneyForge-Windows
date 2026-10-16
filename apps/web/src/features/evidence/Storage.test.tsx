import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StoragePage } from "./Storage";
import { api } from "../../shared/api/client";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function setup() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <StoragePage />
    </QueryClientProvider>,
  );
}
describe("storage status", () => {
  it("shows actual retention and distinguishes capacity from sensor activity", async () => {
    vi.spyOn(api, "storage").mockResolvedValue({
      event_retention_days: 7,
      audit_retention_days: 30,
      reserved_bytes: 1024,
      quota_bytes: 2048,
      pinned_cases: 2,
      collection_available: false,
    });
    setup();
    expect(await screen.findByText("7 дней")).toBeTruthy();
    expect(screen.getByText("30 дней")).toBeTruthy();
    expect(screen.getByText(/лимит хранения исчерпан/)).toBeTruthy();
    expect(screen.getByText(/не подтверждение работы сенсора/)).toBeTruthy();
  });
  it("shows a request failure without invented zero usage or retention", async () => {
    vi.spyOn(api, "storage").mockRejectedValue(
      new Error("Storage unavailable"),
    );
    setup();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Storage unavailable",
    );
    expect(screen.queryByText("7 дней")).toBeNull();
    expect(screen.queryByText(/0 B/)).toBeNull();
  });
});
