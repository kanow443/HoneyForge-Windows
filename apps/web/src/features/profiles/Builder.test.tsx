import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { BuilderPage } from "./Builder";
import { api } from "../../shared/api/client";
import type { Config, Profile } from "../../shared/api/models";
vi.mock("../auth/Auth", () => ({
  useAuth: () => ({ user: { role: "admin" } }),
}));
Object.defineProperty(Range.prototype, "getClientRects", { value: () => [] });
Object.defineProperty(Range.prototype, "getBoundingClientRect", {
  value: () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
    width: 0,
    height: 0,
  }),
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});
function studio(path = "/profiles/new") {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/profiles/new" element={<BuilderPage />} />
          <Route path="/profiles/:id/edit" element={<BuilderPage />} />
          <Route
            path="/profiles/:id"
            element={<div>Профиль опубликован</div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
describe("конструктор ловушек", () => {
  it("keeps a published v1 intact and upgrades only after the operator chooses v2", async () => {
    const config: Config = {
      schema_version: 1,
      adapter: "http",
      hostname: "legacy-host",
      persona: "Legacy archive",
      template: "asset-console",
      server_banner: "old-server",
      decoy_files: [{ path: "/opt/decoy/old.txt", content: "preserve me" }],
      limits: { memory_mb: 128, cpu: 0.5, pids: 64 },
    };
    const p: Profile = {
      id: "legacy",
      name: "Legacy lab",
      description: "",
      adapter: "http",
      interaction_level: "medium",
      latest_version: 1,
      created_at: "2026-10-10T10:00:00Z",
      versions: [
        {
          id: "v1",
          profile_id: "legacy",
          number: 1,
          config,
          config_hash: "old-hash",
          created_at: "2026-10-10T10:00:00Z",
        },
      ],
    };
    vi.spyOn(api, "profile").mockResolvedValue(p);
    const publish = vi
      .spyOn(api, "version")
      .mockResolvedValue({ ...p.versions[0], number: 2 });
    const user = userEvent.setup();
    studio("/profiles/legacy/edit");
    await screen.findByRole("button", { name: "Перейти к настройкам v2" });
    expect((screen.getByLabelText("Имя хоста") as HTMLInputElement).value).toBe(
      "legacy-host",
    );
    expect(config.schema_version).toBe(1);
    await user.click(
      screen.getByRole("button", { name: "Перейти к настройкам v2" }),
    );
    expect(
      screen.queryByRole("button", { name: "Перейти к настройкам v2" }),
    ).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Проверить и опубликовать" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Опубликовать версию" }),
    );
    await waitFor(() => expect(publish).toHaveBeenCalled());
    expect(publish.mock.calls[0][1].config).toMatchObject({
      schema_version: 2,
      hostname: "legacy-host",
      server_banner: "old-server",
      recommended_port: 18080,
      decoy_files: [{ path: "/opt/decoy/old.txt", content: "preserve me" }],
    });
    expect(p.versions[0].config).toEqual(config);
    expect(config.schema_version).toBe(1);
  });
  it("publishes Low as v2 with its selected banner and no shell preview", async () => {
    const create = vi
      .spyOn(api, "createProfile")
      .mockResolvedValue({ id: "new-profile" } as never);
    const user = userEvent.setup();
    studio();
    await user.selectOptions(screen.getByLabelText("Протокол"), "tcp-banner");
    expect(screen.getByLabelText("Баннер TCP").closest("details")).toBeNull();
    expect(screen.queryByLabelText("Команда в предпросмотре SSH")).toBeNull();
    expect(
      screen.getByText(/Вход, команды и файловая система отсутствуют/),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Файлы" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await user.type(screen.getByLabelText("Название профиля"), "Banner lab");
    await user.clear(screen.getByLabelText("Баннер TCP"));
    await user.type(screen.getByLabelText("Баннер TCP"), "LabService 1.0");
    await user.click(
      screen.getByRole("button", { name: "Проверить и опубликовать" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Опубликовать версию" }),
    );
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0].config).toMatchObject({
      adapter: "tcp-banner",
      schema_version: 2,
      banner: "LabService 1.0",
      recommended_port: 2223,
    });
  });
  it("keeps SSH downloads blocked by default and only shows the fixture command after explicit selection", async () => {
    const user = userEvent.setup();
    studio();
    await user.selectOptions(screen.getByLabelText("Протокол"), "cowrie");
    const mode = screen.getByLabelText("Загрузка файлов", { exact: false });
    expect((mode as HTMLSelectElement).value).toBe("blocked");
    expect(
      screen.queryByText(
        "wget http://downloads.honeyforge.test:18090/sample.txt",
      ),
    ).toBeNull();
    await user.selectOptions(mode, "fixture");
    expect(
      screen.getByText(
        "wget http://downloads.honeyforge.test:18090/sample.txt",
      ),
    ).toBeTruthy();
    await user.selectOptions(mode, "blocked");
    expect(
      screen.queryByText(
        "wget http://downloads.honeyforge.test:18090/sample.txt",
      ),
    ).toBeNull();
  });
  it("проверяет название и создаёт профиль только после явного подтверждения", async () => {
    const create = vi
        .spyOn(api, "createProfile")
        .mockResolvedValue({ id: "new-profile" } as never),
      user = userEvent.setup();
    studio();
    await user.click(
      screen.getByRole("button", { name: "Проверить и опубликовать" }),
    );
    expect(create).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("название");
    await user.type(screen.getByLabelText("Название профиля"), "Test lab");
    await user.click(
      screen.getByRole("button", { name: "Проверить и опубликовать" }),
    );
    expect(
      screen.getByRole("heading", { name: "Проверьте перед публикацией" }),
    ).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Опубликовать версию" }),
    );
    await waitFor(() =>
      expect(screen.getByText("Профиль опубликован")).toBeTruthy(),
    );
    expect(create).toHaveBeenCalledOnce();
  });
  it("сохраняет общую легенду и файлы при смене протокола; отменяет смену", async () => {
    const user = userEvent.setup();
    studio();
    const persona = screen.getByLabelText("Название сервиса");
    await user.clear(persona);
    await user.type(persona, "Finance archive");
    await user.selectOptions(screen.getByLabelText("Протокол"), "cowrie");
    expect(
      (screen.getByLabelText("Название сервиса") as HTMLInputElement).value,
    ).toBe("Finance archive");
    expect(
      screen.getByRole("button", { name: "cat /opt/decoy/backup-notes.txt" }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Отменить изменение" }),
    );
    expect(
      screen.getByLabelText("Баннер HTTP-сервера", { exact: false }),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText("Название сервиса") as HTMLInputElement).value,
    ).toBe("Finance archive");
  });
  it("восстанавливает изменённый черновик после повторного открытия вкладки", async () => {
    const user = userEvent.setup(),
      view = studio();
    await user.type(screen.getByLabelText("Название профиля"), "Recovery lab");
    await waitFor(
      () =>
        expect(
          JSON.parse(
            sessionStorage.getItem("honeyforge.profile-draft.new") ?? "{}",
          ).draft.name,
        ).toBe("Recovery lab"),
      { timeout: 2000 },
    );
    view.unmount();
    studio();
    expect(
      (screen.getByLabelText("Название профиля") as HTMLInputElement).value,
    ).toBe("Recovery lab");
    expect(screen.getByRole("status").textContent).toContain(
      "Восстановлен черновик",
    );
  });
  it("блокирует публикацию файла вне разрешённых каталогов и сохраняет его содержимое", async () => {
    const create = vi.spyOn(api, "createProfile"),
      user = userEvent.setup();
    create.mockClear();
    studio();
    await user.selectOptions(screen.getByLabelText("Образ сервиса"), "bastion");
    await user.click(screen.getByRole("button", { name: "Файлы" }));
    await user.clear(await screen.findByLabelText("Путь файла"));
    await user.type(screen.getByLabelText("Путь файла"), "/etc/passwd");
    await user.click(
      screen.getByRole("button", { name: "Проверить и опубликовать" }),
    );
    expect(create).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Абсолютный путь");
    expect(screen.getByLabelText("Содержимое файла").textContent).toContain(
      "Development deployment notes",
    );
  });
  it("предпросмотр читает файлы выбранной легенды; вкладки доступны с клавиатуры", async () => {
    const user = userEvent.setup();
    studio();
    await user.selectOptions(screen.getByLabelText("Образ сервиса"), "bastion");
    await user.click(screen.getByRole("button", { name: "Файлы" }));
    await user.click(
      screen.getByRole("button", { name: "cat /home/admin/deploy-notes.txt" }),
    );
    expect(
      screen.getByText(/Development deployment notes/, { selector: "pre" }),
    ).toBeTruthy();
    screen.getByRole("tab", { name: "Сервис" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(
      screen.getByRole("tab", { name: "Файлы" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { name: "Файлы" }),
    );
  });
});
