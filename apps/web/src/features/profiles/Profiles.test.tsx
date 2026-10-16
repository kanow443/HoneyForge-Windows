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
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ProfileDetail } from "./Profiles";
import { defaultConfig } from "./config";
import { api, ApiError } from "../../shared/api/client";
import type { Profile } from "../../shared/api/models";
const auth = vi.hoisted(() => ({ user: { role: "operator" } }));
vi.mock("../auth/Auth", () => ({ useAuth: () => auth }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  auth.user.role = "operator";
});
const profile: Profile = {
  id: "p",
  name: "Banner lab",
  description: "Lab only",
  adapter: "tcp-banner",
  interaction_level: "low",
  latest_version: 1,
  archived_at: null,
  created_at: "2026-10-10T10:00:00Z",
  versions: [
    {
      id: "v",
      profile_id: "p",
      number: 1,
      created_at: "2026-10-10T10:00:00Z",
      config: defaultConfig("tcp-banner"),
      config_hash: "hash",
    },
  ],
};
function setup(p = profile) {
  vi.spyOn(api, "profile").mockResolvedValue(p);
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={["/profiles/p"]}>
        <Routes>
          <Route path="/profiles/:id" element={<ProfileDetail />} />
          <Route path="/profiles" element={<div>Profile register</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
describe("profile lifecycle", () => {
  it("requires archive confirmation and explains running traps continue", async () => {
    const call = vi
      .spyOn(api, "profileLifecycle")
      .mockResolvedValue({ ...profile, archived_at: "2026-10-10T11:00:00Z" });
    setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "В архив" }));
    expect(call).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(/работу существующих ловушек/),
    ).toBeTruthy();
    await user.click(
      within(dialog).getByRole("button", { name: "Архивировать профиль" }),
    );
    await waitFor(() => expect(call).toHaveBeenCalledWith("p", "archive"));
  });
  it("does not offer version publication or deployment for archived profiles", async () => {
    setup({ ...profile, archived_at: "2026-10-10T11:00:00Z" });
    await screen.findByRole("button", { name: "Восстановить" });
    expect(screen.queryByRole("link", { name: /Развернуть/ })).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Создать новую версию" }),
    ).toBeNull();
    expect(screen.getByText(/Работающие ловушки продолжают/)).toBeTruthy();
  });
  it("keeps an in-use profile after actual server deletion rejection", async () => {
    const remove = vi
      .spyOn(api, "deleteProfile")
      .mockRejectedValue(
        new ApiError(409, "profile_in_use", "Profile has deployment history"),
      );
    setup();
    const user = userEvent.setup();
    await user.click(await screen.findByText("Другие действия"));
    await user.click(screen.getByRole("button", { name: "Удалить профиль" }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Удалить профиль",
      }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain("история");
    expect(screen.queryByText("Profile register")).toBeNull();
    expect(remove).toHaveBeenCalledWith("p");
  });
  it("edits metadata without publishing or rewriting config", async () => {
    const metadata = vi
      .spyOn(api, "profileMetadata")
      .mockResolvedValue({ ...profile, name: "Renamed lab" });
    const publish = vi.spyOn(api, "version");
    setup();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Изменить сведения" }),
    );
    const dialog = screen.getByRole("dialog");
    await user.clear(within(dialog).getByLabelText("Название профиля"));
    await user.type(
      within(dialog).getByLabelText("Название профиля"),
      "Renamed lab",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Изменить сведения" }),
    );
    await waitFor(() =>
      expect(metadata).toHaveBeenCalledWith("p", {
        name: "Renamed lab",
        description: "Lab only",
      }),
    );
    expect(publish).not.toHaveBeenCalled();
  });
  it("does not expose mutation actions to an analyst", async () => {
    auth.user.role = "analyst";
    setup();
    await screen.findByRole("heading", { name: "Banner lab" });
    expect(screen.queryByRole("button", { name: "В архив" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Изменить сведения" }),
    ).toBeNull();
  });
});
