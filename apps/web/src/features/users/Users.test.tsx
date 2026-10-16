import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api, ApiError } from "../../shared/api/client";
import { UsersPage } from "./Users";
const auth = vi.hoisted(() => ({
  user: { id: "admin", username: "admin", role: "admin" },
  setUser: vi.fn(),
}));
vi.mock("../auth/Auth", () => ({ useAuth: () => auth }));
afterEach(() => {
  cleanup();
  auth.user.role = "admin";
});
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UsersPage />
    </QueryClientProvider>,
  );
  return client;
}
describe("administrator user management", () => {
  it("does not request the admin-only user list for a viewer", () => {
    auth.user.role = "viewer";
    const request = vi.spyOn(api, "users");
    setup();
    expect(request).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Добавить пользователя" }),
    ).toBeNull();
  });
  it("defaults new users to viewer, sends the chosen role and clears the password after success", async () => {
    vi.spyOn(api, "users").mockResolvedValue([auth.user as never]);
    const create = vi
      .spyOn(api, "createUser")
      .mockResolvedValue({
        id: "viewer",
        username: "new-reader",
        role: "viewer",
      });
    setup();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Добавить пользователя" }),
    );
    expect((screen.getByLabelText("Роль") as HTMLSelectElement).value).toBe(
      "viewer",
    );
    await user.type(
      screen.getByLabelText("Имя пользователя", { exact: false }),
      "new-reader",
    );
    await user.type(
      screen.getByLabelText("Пароль", { exact: false }),
      "synthetic-test-only-password",
    );
    await user.click(
      screen.getByRole("button", { name: "Создать пользователя" }),
    );
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        username: "new-reader",
        password: "synthetic-test-only-password",
        role: "viewer",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByLabelText("Пароль", { exact: false })).toBeNull(),
    );
    await user.click(
      screen.getByRole("button", { name: "Добавить пользователя" }),
    );
    expect(
      (screen.getByLabelText("Пароль", { exact: false }) as HTMLInputElement)
        .value,
    ).toBe("");
  });
  it("prevents last-admin demotion and discloses session revocation", async () => {
    vi.spyOn(api, "users").mockResolvedValue([auth.user as never]);
    setup();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Изменить роль" }),
    );
    expect(
      (screen.getByRole("option", { name: "Наблюдатель" }) as HTMLOptionElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/Это последний администратор/)).toBeTruthy();
    expect(
      screen.getByText(/Все активные сеансы этой учётной записи завершатся/),
    ).toBeTruthy();
  });
  it("preserves the current role after a server rejection rather than showing optimistic success", async () => {
    vi.spyOn(api, "users").mockResolvedValue([
      auth.user as never,
      { id: "second", username: "another-admin", role: "admin" },
    ]);
    vi.spyOn(api, "userRole").mockRejectedValue(
      new ApiError(409, "last_admin", "Protected"),
    );
    setup();
    const user = userEvent.setup();
    await user.click(
      within(
        await screen.findByRole("row", { name: /another-admin/ }),
      ).getByRole("button", { name: "Изменить роль" }),
    );
    await user.selectOptions(screen.getByLabelText("Новая роль"), "viewer");
    await user.click(screen.getByRole("button", { name: "Сохранить роль" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("another-admin")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Сохранить роль" })).toBeTruthy();
  });
});
