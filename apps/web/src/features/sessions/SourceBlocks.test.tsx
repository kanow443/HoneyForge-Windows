import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { SourceBlock } from "../../shared/api/models";
import { BlockState, SourceBlocks } from "./SourceBlocks";
const auth = vi.hoisted(() => ({ user: { role: "admin" } }));
vi.mock("../auth/Auth", () => ({ useAuth: () => auth }));
afterEach(() => { cleanup(); auth.user.role = "admin"; });
const block: SourceBlock = {
  id: "policy",
  created_at: "2026-10-10T10:00:00Z",
  deployment_id: "d",
  deployment_name: "trap",
  host_id: "h",
  generation: "g",
  source_ip: "203.0.113.99",
  reason: "Observed test",
  expires_at: "2099-10-10T10:01:00Z",
  desired_state: "blocked",
  revision: 4,
  observed_revision: 0,
  observed_state: "pending",
  observed_at: null,
  error: null,
  created_by: "operator",
  state: "pending",
  terminate_sessions: false,
  termination_state: "not_requested",
  terminated_sessions: [],
  termination_error: null,
};
function setup(adapter: "http" | "cowrie" = "http") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SourceBlocks deploymentId="d" adapter={adapter} />
    </QueryClientProvider>,
  );
  return client;
}
describe("agent acknowledged source policy", () => {
  it("keeps observed restrictions readable but denies analyst runtime actions", async () => {
    auth.user.role = "analyst";
    vi.spyOn(api, "blocks").mockResolvedValue([block]);
    setup("cowrie");
    expect((screen.getByRole("button", { name: "Ограничить доступ" }) as HTMLButtonElement).disabled).toBe(true);
    const cancel = await screen.findByRole("button", { name: "Отменить ограничение" });
    expect((cancel as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Управление профилями, ловушками и ограничениями доступно/)).toBeTruthy();
    auth.user.role = "admin";
  });
  it("defaults SSH closure on, sends an explicit opt-out, and renews idempotency when the operator changes the action after a failure", async () => {
    vi.spyOn(api, "blocks").mockResolvedValue([]);
    const create = vi
      .spyOn(api, "block")
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({
        ...block,
        terminate_sessions: true,
        termination_state: "pending",
      });
    setup("cowrie");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Ограничить доступ" }));
    const checkbox = screen.getByRole("checkbox", {
      name: /Завершить открытые SSH-сессии/,
    });
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    await user.type(screen.getByLabelText("IP источника"), "203.0.113.99");
    await user.type(screen.getByLabelText("Причина"), "Observed test");
    await user.click(checkbox);
    await user.click(
      screen.getByRole("button", {
        name: "Запросить ограничение",
      }),
    );
    await screen.findByRole("alert");
    expect(create.mock.calls[0][0].terminate_sessions).toBe(false);
    await user.click(checkbox);
    await user.click(
      screen.getByRole("button", {
        name: "Ограничить доступ и завершить сессии",
      }),
    );
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1][0].terminate_sessions).toBe(true);
    expect(create.mock.calls[1][1]).not.toBe(create.mock.calls[0][1]);
  });
  it("does not equate an applied firewall with confirmed termination of an existing transport", async () => {
    vi.spyOn(api, "blocks").mockResolvedValue([
      {
        ...block,
        state: "applied",
        observed_state: "applied",
        observed_revision: 4,
        terminate_sessions: true,
        termination_state: "pending",
      },
    ]);
    const client = setup("cowrie");
    await screen.findByText("Подтверждено агентом");
    expect(screen.getByRole("status").textContent).toContain(
      "Ожидаем подтверждение завершения",
    );
    expect(screen.queryByText(/Агент подтвердил завершение/)).toBeNull();
    client.setQueryData(
      ["blocks", "d"],
      [
        {
          ...block,
          state: "applied",
          observed_state: "applied",
          observed_revision: 4,
          terminate_sessions: true,
          termination_state: "unsupported",
          terminated_sessions: [],
          termination_error: "Unsupported runtime",
        },
      ],
    );
    await screen.findByText("Unsupported runtime");
    expect(screen.getByText("Подтверждено агентом")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("не поддерживает");
  });
  it("does not label a release request cancelled before the agent acknowledges it", () => {
    const view = render(
      <BlockState
        block={{
          ...block,
          desired_state: "released",
          state: "unknown",
          revision: 5,
          observed_revision: 4,
        }}
      />,
    );
    expect(screen.getByText("Ожидает подтверждения отмены")).toBeTruthy();
    expect(screen.queryByText("Отменено")).toBeNull();
    view.rerender(
      <BlockState
        block={{
          ...block,
          desired_state: "released",
          state: "cancelled",
          revision: 5,
          observed_revision: 5,
        }}
      />,
    );
    expect(screen.getByText("Отменено")).toBeTruthy();
  });
  it("shows pending until server ACK and cancels with the current revision", async () => {
    let list: SourceBlock[] = [];
    vi.spyOn(api, "blocks").mockImplementation(async () => list);
    const create = vi.spyOn(api, "block").mockImplementation(async () => {
        list = [block];
        return block;
      }),
      cancel = vi
        .spyOn(api, "cancelBlock")
        .mockResolvedValue({ ...block, desired_state: "released" });
    const client = setup(),
      user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Заблокировать источник" }),
    );
    await user.type(screen.getByLabelText("IP источника"), "203.0.113.99");
    await user.type(screen.getByLabelText("Причина"), "Observed test");
    await user.click(
      screen.getByRole("button", { name: "Запросить ограничение" }),
    );
    await screen.findByText("Ожидает применения");
    expect(screen.queryByText("Подтверждено агентом")).toBeNull();
    expect(create.mock.calls[0][0]).toEqual({
      deployment_id: "d",
      source_ip: "203.0.113.99",
      ttl_seconds: 60,
      reason: "Observed test",
      terminate_sessions: false,
    });
    list = [
      {
        ...block,
        state: "applied",
        observed_state: "applied",
        observed_revision: 4,
        observed_at: "2026-10-10T10:00:01Z",
      },
    ];
    await client.invalidateQueries({ queryKey: ["blocks"] });
    await screen.findByText("Подтверждено агентом");
    await user.click(
      screen.getByRole("button", { name: "Отменить ограничение" }),
    );
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("policy", 4));
  });
  it("reuses idempotency after a network failure, without optimistic success", async () => {
    vi.spyOn(api, "blocks").mockResolvedValue([]);
    const create = vi
      .spyOn(api, "block")
      .mockRejectedValueOnce(new Error("No connection"))
      .mockResolvedValue(block);
    setup();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Заблокировать источник" }),
    );
    await user.type(screen.getByLabelText("IP источника"), "203.0.113.99");
    await user.type(screen.getByLabelText("Причина"), "Observed test");
    await user.click(
      screen.getByRole("button", { name: "Запросить ограничение" }),
    );
    await screen.findByRole("alert");
    expect(screen.queryByText("Подтверждено агентом")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Запросить ограничение" }),
    );
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[0][1]).toBe(create.mock.calls[1][1]);
  });
});
