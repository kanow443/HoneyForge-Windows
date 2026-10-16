import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { HostsPage } from "./Hosts";
import { api } from "../../shared/api/client";
import type { Host } from "../../shared/api/models";

const auth = vi.hoisted(() => ({ user: { role: "viewer" } }));
vi.mock("../auth/Auth", () => ({ useAuth: () => auth }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  auth.user.role = "viewer";
});
function setup() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <HostsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const host: Host = {
  id: "sensor",
  created_at: "2026-10-10T10:00:00Z",
  name: "Lab sensor",
  address: "192.0.2.1",
  last_seen: null,
  revoked_at: null,
  capabilities: ["tcp-banner", "http", "future-protocol"],
  metrics: {},
  runtime_version: "lab",
  status: "offline",
};
describe("honest host status", () => {
  it("does not turn failed telemetry into zero hosts or zero losses", async () => {
    vi.spyOn(api, "hosts").mockRejectedValue(
      new Error("Host telemetry unavailable"),
    );
    const { container } = setup();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Host telemetry unavailable",
    );
    expect(
      [...container.querySelectorAll(".fleet-readout b")].map(
        (el) => el.textContent,
      ),
    ).toEqual(["—", "—", "—", "—"]);
  });
  it("keeps missing metrics unknown and never labels TCP or unknown adapters as SSH", async () => {
    vi.spyOn(api, "hosts").mockResolvedValue([host]);
    const { container } = setup();
    await screen.findByText("Lab sensor");
    const table = within(screen.getByRole("table"));
    expect(table.getByText("TCP-баннер")).toBeTruthy();
    expect(table.getByText("future-protocol")).toBeTruthy();
    expect(table.queryByText("SSH")).toBeNull();
    expect(table.getByText("В очереди —")).toBeTruthy();
    expect(table.getByText("Потери —")).toBeTruthy();
    expect(
      [...container.querySelectorAll(".fleet-readout b")].map(
        (el) => el.textContent,
      ),
    ).toEqual(["1", "0", "—", "—"]);
  });
  it("does not offer active enrollment controls to a read-only user on an empty fleet", async () => {
    vi.spyOn(api, "hosts").mockResolvedValue([]);
    setup();
    await screen.findByText("Подключите первый sensor host");
    for (const button of screen.getAllByRole("button", {
      name: "Подключить хост",
    }))
      expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
