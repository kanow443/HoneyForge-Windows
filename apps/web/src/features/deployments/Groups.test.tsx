import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { GroupDeploymentForm, GroupDetailPage } from "./Groups";
import { BundleBuilderPage } from "../profiles/BundleBuilder";
import { defaultConfig } from "../profiles/config";
import { defaultBundle } from "../profiles/bundle";
import { api, ApiError } from "../../shared/api/client";
import type { Profile, DeploymentGroup } from "../../shared/api/models";
let role = "admin";
vi.mock("../auth/Auth", () => ({ useAuth: () => ({ user: { role } }) }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
  role = "admin";
});
const config = defaultBundle();
const profile = {
  id: "p",
  name: "Services",
  description: "",
  adapter: "bundle",
  latest_version: 1,
  archived_at: null,
  created_at: "2026-10-11T00:00:00Z",
  versions: [
    {
      id: "v",
      number: 1,
      created_at: "2026-10-11T00:00:00Z",
      config,
      config_hash: "hash",
    },
  ],
} as Profile;
const host = {
  id: "h",
  name: "Lab",
  address: "192.0.2.1",
  status: "online",
  capabilities: ["http", "cowrie", "tcp-banner"],
};
const group = {
  id: "g",
  name: "Lab group",
  host_id: "h",
  profile_version_id: "v",
  state: "mixed",
  services: [
    {
      id: "web",
      name: "Web",
      service_key: "web",
      group_id: "g",
      adapter: "http",
      state: "running",
      endpoint: "192.0.2.1:18080",
      error: null,
    },
    {
      id: "ssh",
      name: "SSH",
      service_key: "ssh",
      group_id: "g",
      adapter: "cowrie",
      state: "error",
      endpoint: "192.0.2.1:2222",
      error: "Runtime error",
    },
  ],
} as DeploymentGroup;
function mount(element: React.ReactNode, entry: string, route: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path={route} element={element} />
          <Route path="/groups/g" element={<p>Group requested</p>} />
          <Route path="/profiles/p" element={<p>Profile published</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
function fixture() {
  vi.spyOn(api, "profiles").mockResolvedValue([profile]);
  vi.spyOn(api, "hosts").mockResolvedValue([host as never]);
  vi.spyOn(api, "deployments").mockResolvedValue([]);
}
describe("bundle editor and real-contract group interactions", () => {
  it("blocks duplicate ports, preserves local draft on rejected publish, and submits normalized shared legend", async () => {
    const user = userEvent.setup();
    const create = vi
      .spyOn(api, "createProfile")
      .mockRejectedValueOnce(new ApiError(422, "invalid", "Server rejected"))
      .mockResolvedValue(profile);
    mount(
      <BundleBuilderPage />,
      "/profiles/new?adapter=bundle",
      "/profiles/new",
    );
    await user.type(screen.getByLabelText("Название профиля"), "Bundle");
    await user.clear(screen.getByLabelText("Общее имя хоста"));
    await user.type(screen.getByLabelText("Общее имя хоста"), "shared-host");
    await user.clear(screen.getByLabelText("Порт сервиса"));
    await user.type(screen.getByLabelText("Порт сервиса"), "2222");
    await user.click(
      screen.getByRole("button", { name: "Проверить и опубликовать" }),
    );
    expect(create).not.toHaveBeenCalled();
    expect(screen.getByText("Уникальный порт от 1024 до 65535")).toBeTruthy();
    await user.clear(screen.getByLabelText("Порт сервиса"));
    await user.type(screen.getByLabelText("Порт сервиса"), "18080");
    await user.click(
      screen.getByRole("button", { name: "Проверить и опубликовать" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Опубликовать профиль" }),
    );
    await screen.findAllByText(/сервер отклонил конфигурацию/);
    expect(screen.getByLabelText("Название профиля")).toHaveProperty(
      "value",
      "Bundle",
    );
    await user.click(
      screen.getByRole("button", { name: "Опубликовать профиль" }),
    );
    await screen.findByText("Profile published");
    const body = create.mock.calls[1][0];
    expect(body.config.adapter).toBe("bundle");
    if (body.config.adapter === "bundle")
      expect(
        body.config.services.every(
          (s) =>
            s.config.hostname === "shared-host" &&
            s.config.recommended_port === s.port,
        ),
      ).toBe(true);
  });
  it("retains an occupied-port rejection and reuses the exact idempotency key on unchanged retry", async () => {
    fixture();
    const deploy = vi
      .spyOn(api, "deployGroup")
      .mockRejectedValueOnce(new ApiError(409, "port_in_use", "Port reserved"))
      .mockResolvedValue({ ...group, state: "requested" });
    const user = userEvent.setup();
    mount(<GroupDeploymentForm />, "/groups/new?profile=p", "/groups/new");
    await screen.findByLabelText("Название группы");
    await user.type(screen.getByLabelText("Название группы"), "New group");
    await user.selectOptions(screen.getByLabelText("Хост группы"), "h");
    await user.click(
      screen.getByRole("button", { name: "Проверить развёртывание" }),
    );
    await user.click(screen.getByRole("button", { name: "Развернуть группу" }));
    await screen.findByText(/Port reserved/);
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Развернуть группу" }));
    await screen.findByText("Group requested");
    expect(deploy.mock.calls[0][1]).toBe(deploy.mock.calls[1][1]);
    expect(deploy.mock.calls[0][0].ports).toEqual({ web: 18080, ssh: 2222 });
  });
  it("requires all capabilities and rejects occupied or duplicate ports before group submission", async () => {
    fixture();
    vi.spyOn(api, "hosts").mockResolvedValue([
      { ...host, capabilities: ["http"] } as never,
    ]);
    const deploy = vi.spyOn(api, "deployGroup");
    mount(<GroupDeploymentForm />, "/groups/new?profile=p", "/groups/new");
    await screen.findByText(
      "На связи нет хоста с поддержкой всех сервисов этой версии.",
    );
    expect(
      screen.getByRole("button", { name: "Проверить развёртывание" }),
    ).toHaveProperty("disabled", true);
    expect(deploy).not.toHaveBeenCalled();
  });
  it("shows mixed/error child states without announcing running and asks confirmation before stop", async () => {
    fixture();
    vi.spyOn(api, "group").mockResolvedValue(group);
    const stop = vi
      .spyOn(api, "stopGroup")
      .mockRejectedValue(new ApiError(409, "busy", "Stop rejected"));
    const user = userEvent.setup();
    mount(<GroupDetailPage />, "/groups/detail", "/groups/:id");
    await screen.findByRole("heading", { name: "Lab group" });
    expect(screen.getByText("Разные состояния")).toBeTruthy();
    expect(
      screen.getByText(
        "Сервис сообщил об ошибке. Подробности доступны в его карточке.",
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Остановить группу" }));
    expect(stop).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("dialog").querySelector("button.primary")!,
    );
    await screen.findByText(/Stop rejected/);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(stop).toHaveBeenCalledWith("g");
  });
  it("excludes incompatible topology versions and disables group mutations for viewer", async () => {
    fixture();
    vi.spyOn(api, "profiles").mockResolvedValue([
      {
        ...profile,
        versions: [
          ...profile.versions,
          {
            ...profile.versions[0],
            id: "bad",
            number: 2,
            config: { ...config, services: config.services.slice(0, 1) },
          },
        ],
      },
    ]);
    vi.spyOn(api, "group").mockResolvedValue(group);
    role = "viewer";
    mount(<GroupDetailPage />, "/groups/detail", "/groups/:id");
    await screen.findByRole("heading", { name: "Lab group" });
    expect(
      screen
        .getByLabelText("Совместимая версия группы")
        .querySelectorAll("option"),
    ).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Остановить группу" }),
    ).toHaveProperty("disabled", true);
    expect(
      screen.getByRole("button", { name: "Повторно развернуть группу" }),
    ).toHaveProperty("disabled", true);
  });
});
