import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Honeytokens } from "./Honeytokens";
import { defaultConfig } from "./config";
import { api, ApiError } from "../../shared/api/client";
import type { Profile, ProfileConfig } from "../../shared/api/models";
vi.mock("../auth/Auth", () => ({
  useAuth: () => ({ user: { role: "operator" } }),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function profile(config: ProfileConfig): Profile {
  return {
    id: "p",
    name: "Lab",
    description: "",
    adapter: config.adapter,
    interaction_level: config.adapter === "bundle" ? "mixed" : "medium",
    latest_version: 1,
    archived_at: null,
    created_at: "2026-10-11T00:00:00Z",
    versions: [
      {
        id: "v",
        profile_id: "p",
        number: 1,
        created_at: "2026-10-11T00:00:00Z",
        config,
        config_hash: "hash",
      },
    ],
  };
}
const bundle = () =>
  profile({
    schema_version: 3,
    adapter: "bundle",
    hostname: "lab",
    persona: "Lab",
    services: [
      { key: "web", port: 18080, config: defaultConfig("http") },
      { key: "ssh", port: 2222, config: defaultConfig("cowrie") },
      { key: "low", port: 2223, config: defaultConfig("tcp-banner") },
    ],
  });
function token(service_key: string | null = null) {
  return {
    id: "t",
    name: "Bait " + service_key,
    profile_id: "p",
    profile_version_id: "v",
    service_key,
    created_at: "2026-10-11T00:00:00Z",
    kind: "file" as const,
    file_path: "/opt/decoy/bait.txt",
    created_by: "operator",
    revoked_at: null,
    bindings: [],
    application: "next explicit redeploy",
  };
}
function setup(p: Profile) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <Honeytokens profile={p} version={p.versions[0]} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}
async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByText("Маркеры-приманки · v1"));
  await user.click(
    await screen.findByRole("button", { name: "Создать маркер" }),
  );
  return within(screen.getByRole("dialog"));
}
describe("SSH and service-scoped honeytokens", () => {
  it("issues a file-only marker for single SSH without adding a service key", async () => {
    vi.spyOn(api, "honeytokens").mockResolvedValue([]);
    const create = vi.spyOn(api, "createHoneytoken").mockResolvedValue(token());
    const user = setup(profile(defaultConfig("cowrie"))),
      dialog = await open(user);
    expect(dialog.getByLabelText("Тип маркера")).toHaveProperty(
      "value",
      "file",
    );
    expect(dialog.queryByRole("option", { name: "Уникальный URL" })).toBeNull();
    await user.type(dialog.getByLabelText("Название маркера"), "SSH bait");
    await user.click(dialog.getByLabelText(/Применю маркер отдельным/));
    await user.click(dialog.getByRole("button", { name: "Создать маркер" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        profile_version_id: "v",
        name: "SSH bait",
        kind: "file",
        file_path: "/opt/decoy/access-notes.txt",
      }),
    );
  });
  it("scopes lists and issuance to the selected v3 SSH service and resets the HTTP URL choice", async () => {
    vi.spyOn(api, "honeytokens").mockResolvedValue([
      token("web"),
      { ...token("ssh"), id: "ssh-token" },
    ]);
    const create = vi
      .spyOn(api, "createHoneytoken")
      .mockResolvedValue(token("ssh"));
    const user = setup(bundle());
    await user.click(screen.getByText("Маркеры-приманки · v1"));
    await screen.findByText("Bait web", { selector: "strong" });
    expect(screen.queryByText("Bait ssh", { selector: "strong" })).toBeNull();
    await user.selectOptions(
      screen.getByLabelText("Сервис для маркеров"),
      "ssh",
    );
    await screen.findByText("Bait ssh", { selector: "strong" });
    expect(screen.queryByText("Bait web", { selector: "strong" })).toBeNull();
    expect(screen.queryByRole("option", { name: /^low/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Создать маркер" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByLabelText("Тип маркера")).toHaveProperty(
      "value",
      "file",
    );
    expect(dialog.queryByRole("option", { name: "Уникальный URL" })).toBeNull();
    await user.type(
      dialog.getByLabelText("Название маркера"),
      "Scoped SSH bait",
    );
    await user.click(dialog.getByLabelText(/Применю маркер отдельным/));
    await user.click(dialog.getByRole("button", { name: "Создать маркер" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        profile_version_id: "v",
        service_key: "ssh",
        name: "Scoped SSH bait",
        kind: "file",
        file_path: "/opt/decoy/access-notes.txt",
      }),
    );
  });
  it("applies the eight-token limit across all services, even when the selected service has none", async () => {
    vi.spyOn(api, "honeytokens").mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => ({ ...token("web"), id: String(i) })),
    );
    const user = setup(bundle());
    await user.click(screen.getByText("Маркеры-приманки · v1"));
    await user.selectOptions(
      screen.getByLabelText("Сервис для маркеров"),
      "ssh",
    );
    await screen.findByText("Маркеров выбранного сервиса пока нет");
    expect(
      screen.getByRole("button", { name: "Создать маркер" }),
    ).toHaveProperty("disabled", true);
  });
  it("preserves selected service and file draft when the API rejects a path conflict", async () => {
    vi.spyOn(api, "honeytokens").mockResolvedValue([]);
    vi.spyOn(api, "createHoneytoken").mockRejectedValue(
      new ApiError(409, "path_conflict", "Bait path is occupied"),
    );
    const user = setup(bundle());
    await user.click(screen.getByText("Маркеры-приманки · v1"));
    await user.selectOptions(
      screen.getByLabelText("Сервис для маркеров"),
      "ssh",
    );
    await user.click(
      await screen.findByRole("button", { name: "Создать маркер" }),
    );
    const dialog = within(screen.getByRole("dialog"));
    await user.type(dialog.getByLabelText("Название маркера"), "SSH conflict");
    await user.click(dialog.getByLabelText(/Применю маркер отдельным/));
    await user.click(dialog.getByRole("button", { name: "Создать маркер" }));
    await screen.findByRole("alert");
    expect(dialog.getByLabelText("Название маркера")).toHaveProperty(
      "value",
      "SSH conflict",
    );
    expect(screen.getByLabelText("Сервис для маркеров")).toHaveProperty(
      "value",
      "ssh",
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
