import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { api, ApiError } from "../../shared/api/client";
import { IntegrationsPage } from "./Integrations";
import type { IntegrationToken } from "../../shared/api/models";
const auth = vi.hoisted(() => ({ user: { role: "admin" } }));
vi.mock("../auth/Auth", () => ({ useAuth: () => auth }));
const token: IntegrationToken = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Test receiver",
  deployment_id: null,
  allow_response: false,
  created_at: "2026-10-10T12:00:00Z",
  expires_at: "2099-10-10T12:00:00Z",
  revoked_at: null,
  last_used_at: null,
  created_by: "admin",
};
const syntheticSecret = "synthetic-test-token-only";
beforeEach(() => {
  auth.user.role = "admin";
  vi.spyOn(api, "integrationTokens").mockResolvedValue([]);
  vi.spyOn(api, "deployments").mockResolvedValue([
    { id: "trap-1", name: "Lab trap" } as never,
  ]);
});
afterEach(() => cleanup());
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <IntegrationsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return client;
}
async function open() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Создать ключ" }));
  return user;
}
describe("integration administration", () => {
  it("denies all non-admin roles without requesting metadata or scopes", () => {
    for (const role of ["viewer", "analyst", "operator", "unknown"]) {
      auth.user.role = role;
      setup();
      expect(screen.queryByRole("button", { name: "Создать ключ" })).toBeNull();
      cleanup();
    }
    expect(api.integrationTokens).not.toHaveBeenCalled();
    expect(api.deployments).not.toHaveBeenCalled();
  });
  it("defaults to read-only with 30 days and stores the one-time secret only in the open dialog", async () => {
    const create = vi
      .spyOn(api, "createIntegrationToken")
      .mockResolvedValue({ token: syntheticSecret, integration: token });
    const client = setup();
    const user = await open();
    expect(
      (screen.getByLabelText("Срок действия, дней") as HTMLInputElement).value,
    ).toBe("30");
    expect(
      (screen.getByLabelText("Разрешить ответные действия") as HTMLInputElement)
        .checked,
    ).toBe(false);
    await user.type(screen.getByLabelText("Название"), "Test receiver");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Создать ключ",
      }),
    );
    await screen.findByRole("heading", { name: "Сохраните ключ" });
    expect(create).toHaveBeenCalledWith({
      name: "Test receiver",
      deployment_id: null,
      expires_days: 30,
      allow_response: false,
    });
    expect(
      (screen.getByLabelText("Ключ доступа") as HTMLInputElement).type,
    ).toBe("password");
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(syntheticSecret);
    expect(client.getMutationCache().getAll()).toHaveLength(0);
    expect(
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ).not.toContain(syntheticSecret);
    await user.click(
      screen.getByRole("button", { name: "Закрыть и очистить" }),
    );
    expect(screen.queryByLabelText("Ключ доступа")).toBeNull();
    await open();
    expect(screen.queryByLabelText("Ключ доступа")).toBeNull();
  });
  it("requires an explicit trap for response and constrains duration", async () => {
    const create = vi.spyOn(api, "createIntegrationToken").mockResolvedValue({
      token: syntheticSecret,
      integration: {
        ...token,
        allow_response: true,
        deployment_id: "trap-1",
      },
    });
    setup();
    const user = await open();
    await screen.findByRole("option", { name: "Lab trap" });
    await user.type(screen.getByLabelText("Название"), "Scoped response");
    await user.click(screen.getByLabelText("Разрешить ответные действия"));
    const submit = within(screen.getByRole("dialog")).getByRole("button", {
      name: "Создать ключ",
    });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await user.selectOptions(screen.getByLabelText("Ловушка"), "trap-1");
    await user.clear(screen.getByLabelText("Срок действия, дней"));
    await user.type(screen.getByLabelText("Срок действия, дней"), "366");
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await user.clear(screen.getByLabelText("Срок действия, дней"));
    await user.type(screen.getByLabelText("Срок действия, дней"), "1");
    await user.click(submit);
    await screen.findByRole("heading", { name: "Сохраните ключ" });
    expect(create).toHaveBeenCalledWith({
      name: "Scoped response",
      deployment_id: "trap-1",
      expires_days: 1,
      allow_response: true,
    });
  });
  it("copies the secret only after an explicit click and clears it when closed with Escape", async () => {
    vi.spyOn(api, "createIntegrationToken").mockResolvedValue({
      token: syntheticSecret,
      integration: token,
    });
    setup();
    const user = await open();
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.type(screen.getByLabelText("Название"), "test");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Создать ключ",
      }),
    );
    await screen.findByLabelText("Ключ доступа");
    expect(copy).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Копировать ключ" }));
    expect(copy).toHaveBeenCalledWith(syntheticSecret);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await open();
    expect(screen.queryByLabelText("Ключ доступа")).toBeNull();
  });
  it("does not show a secret or pretend a key was created after a server error", async () => {
    vi.spyOn(api, "createIntegrationToken").mockRejectedValue(
      new ApiError(409, "integration_quota", "Quota"),
    );
    setup();
    const user = await open();
    await user.type(screen.getByLabelText("Название"), "test");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Создать ключ",
      }),
    );
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByLabelText("Ключ доступа")).toBeNull();
    expect(
      screen.getByText(/проверьте список ключей перед повтором/),
    ).toBeTruthy();
  });
  it("preserves the key on revoke rejection, then reports revocation separately from agent cancellation", async () => {
    vi.mocked(api.integrationTokens).mockResolvedValue([token]);
    const revoke = vi
      .spyOn(api, "revokeIntegrationToken")
      .mockRejectedValueOnce(new ApiError(403, "permission_denied", "Denied"))
      .mockResolvedValueOnce({ ...token, revoked_at: "2026-10-10T15:00:00Z" });
    setup();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", {
        name: "Отозвать ключ Test receiver",
      }),
    );
    expect(
      screen.getByText(/результат зависит от подтверждения агента/),
    ).toBeTruthy();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Отозвать ключ",
      }),
    );
    await screen.findByRole("alert");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByText("Отозван")).toBeNull();
    vi.mocked(api.integrationTokens).mockResolvedValue([
      { ...token, revoked_at: "2026-10-10T15:00:00Z" },
    ]);
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Отозвать ключ",
      }),
    );
    expect(
      await screen.findByText(/снятие подтверждается агентом отдельно/),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      within(screen.getByRole("article")).getByText("Отозван", {
        selector: "span",
      }),
    ).toBeTruthy();
    expect(revoke).toHaveBeenCalledWith(token.id);
  });
  it("discloses the actual fixed event format and required response contract without a connected SIEM badge", async () => {
    setup();
    expect(screen.getByText(/Внешний SIEM не подключён/)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByText("Как подключить получатель событий"));
    expect(screen.getByText("honeyforge-ecs-events-v1")).toBeTruthy();
    expect(
      screen.getByText(/native\/ecs текущим контрактом не предусмотрен/),
    ).toBeTruthy();
    await user.click(screen.getByText("Ответные действия через API"));
    expect(screen.getByText("Idempotency-Key")).toBeTruthy();
    expect(screen.getByText(/Ответ 202 означает запрос/)).toBeTruthy();
  });
});
