import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { EventsPage } from "./Events";
import { api } from "../../shared/api/client";
import { event } from "../sessions/playback.fixtures";
vi.mock("../auth/Auth", () => ({
  useAuth: () => ({ user: { role: "admin" } }),
}));
vi.mock("../../app/LiveProvider", () => ({
  useLive: () => ({ status: "connected", reset: 0 }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("live event rendering", () => {
  it("renders new fetched events automatically, freezes only display on pause, then catches up", async () => {
    const first = {
      ...event("a", 1),
      event_type: "http.request",
      payload: { method: "GET", path: "/first" },
    };
    const second = {
      ...event("b", 2),
      event_type: "http.request",
      payload: { method: "GET", path: "/second" },
    };
    const third = {
      ...event("c", 3),
      event_type: "http.request",
      payload: { method: "GET", path: "/third" },
    };
    const page = (items: (typeof first)[]) => ({
      items,
      total: items.length,
      watermark: items.length,
    });
    const list = vi.spyOn(api, "events").mockResolvedValue(page([first]));
    vi.spyOn(api, "hosts").mockResolvedValue([]);
    vi.spyOn(api, "deployments").mockResolvedValue([]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <EventsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await screen.findByText("/first");
    list.mockResolvedValue(page([second, first]));
    await client.invalidateQueries({ queryKey: ["events"] });
    await screen.findByText("/second");
    await user.click(screen.getByRole("button", { name: "Пауза" }));
    list.mockResolvedValue(page([third, second, first]));
    await client.invalidateQueries({ queryKey: ["events"] });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /1 новых записей/ }),
      ).toBeTruthy(),
    );
    expect(screen.queryByText("/third")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Продолжить" }));
    await screen.findByText("/third");
  });
});
