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
import { MemoryRouter } from "react-router-dom";
import { api, ApiError } from "../../shared/api/client";
import { defaultConfig } from "../profiles/config";
import type { Profile } from "../../shared/api/models";
import { Honeytokens } from "../profiles/Honeytokens";
import { HostCertificates } from "../hosts/HostCertificates";
import { DetectionPolicy } from "./DetectionPolicy";
import { ObservableExport } from "./ObservableExport";
import { GeoSources } from "./GeoSources";
import { FindingTime } from "./FindingTime";
const auth = vi.hoisted(() => ({ user: { role: "operator" } }));
vi.mock("../auth/Auth", () => ({ useAuth: () => auth }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  auth.user.role = "operator";
});
function setup(node: React.ReactNode) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}
const profile: Profile = {
  id: "profile",
  name: "Lab",
  description: "",
  adapter: "http",
  interaction_level: "medium",
  latest_version: 1,
  archived_at: null,
  created_at: "2026-10-10T12:00:00Z",
  versions: [
    {
      id: "version",
      profile_id: "profile",
      number: 1,
      created_at: "2026-10-10T12:00:00Z",
      config: defaultConfig("http"),
      config_hash: "hash",
    },
  ],
};
const token = {
  id: "token",
  profile_id: "profile",
  profile_version_id: "version",
  name: "Lab marker",
  kind: "url" as const,
  file_path: null,
  created_at: "2026-10-10T12:00:00Z",
  created_by: "operator",
  revoked_at: null,
  bindings: [],
  application: "next explicit redeploy",
};
const policy = {
  id: 1,
  revision: 1,
  failed_logins: 5,
  window_seconds: 60,
  enabled: true,
  updated_at: null,
};
const result = {
  format: "stix" as const,
  content: '{"type":"bundle","objects":[]}',
  media_type: "application/stix+json",
  filename: "observed.json",
  event_count: 5000,
  total: 5100,
  truncated: true,
  interpretation: "observed",
};
describe("resource-scoped evidence controls", () => {
  it("issues to the selected immutable version only after an explicit application review", async () => {
    vi.spyOn(api, "honeytokens").mockResolvedValue([]);
    const create = vi.spyOn(api, "createHoneytoken").mockResolvedValue(token);
    const user = setup(
      <Honeytokens profile={profile} version={profile.versions[0]} />,
    );
    await user.click(screen.getByText("Маркеры-приманки · v1"));
    await user.click(
      await screen.findByRole("button", { name: "Создать маркер" }),
    );
    const dialog = within(screen.getByRole("dialog"));
    await user.type(dialog.getByLabelText("Название маркера"), "Lab marker");
    expect(
      (
        dialog.getByRole("button", {
          name: "Создать маркер",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(create).not.toHaveBeenCalled();
    await user.click(dialog.getByLabelText(/Применю маркер отдельным/));
    await user.click(dialog.getByRole("button", { name: "Создать маркер" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        profile_version_id: "version",
        name: "Lab marker",
        kind: "url",
        file_path: null,
      }),
    );
  });
  it("requires revocation review and keeps the resource after server rejection", async () => {
    vi.spyOn(api, "honeytokens").mockResolvedValue([token]);
    const revoke = vi
      .spyOn(api, "revokeHoneytoken")
      .mockRejectedValue(new ApiError(403, "permission_denied", "denied"));
    const user = setup(
      <Honeytokens profile={profile} version={profile.versions[0]} />,
    );
    await user.click(screen.getByText("Маркеры-приманки · v1"));
    await user.click(
      await screen.findByRole("button", { name: "Отозвать маркер" }),
    );
    expect(revoke).not.toHaveBeenCalled();
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText(/может оставаться/)).toBeTruthy();
    await user.click(dialog.getByRole("button", { name: "Отозвать маркер" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Ваша роль",
    );
    expect(screen.getByText("Lab marker", { selector: "strong" })).toBeTruthy();
  });
  it("keeps viewer markers read-only and hides unsupported Low placement", async () => {
    auth.user.role = "viewer";
    vi.spyOn(api, "honeytokens").mockResolvedValue([token]);
    const user = setup(
      <Honeytokens profile={profile} version={profile.versions[0]} />,
    );
    await user.click(screen.getByText("Маркеры-приманки · v1"));
    const button = await screen.findByRole("button", {
      name: "Отозвать маркер",
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    setup(
      <Honeytokens
        profile={{ ...profile, adapter: "tcp-banner" }}
        version={profile.versions[0]}
      />,
    );
    expect(screen.queryByText(/Маркеры-приманки/)).toBeNull();
  });
  it("preserves a detection draft after a revision conflict, then offers explicit recovery", async () => {
    const load = vi.spyOn(api, "detectionPolicy").mockResolvedValue(policy);
    const save = vi
      .spyOn(api, "updateDetectionPolicy")
      .mockRejectedValue(new ApiError(409, "stale_revision", "changed"));
    const user = setup(<DetectionPolicy />);
    await user.click(screen.getByText("Правило повторных входов"));
    await user.click(
      await screen.findByRole("button", { name: "Изменить правило" }),
    );
    const dialog = within(screen.getByRole("dialog")),
      threshold = dialog.getByLabelText("Количество неудачных входов");
    await user.clear(threshold);
    await user.type(threshold, "7");
    load.mockResolvedValue({ ...policy, revision: 2, failed_logins: 9 });
    await user.click(dialog.getByRole("button", { name: "Сохранить правило" }));
    await screen.findByRole("alert");
    expect((threshold as HTMLInputElement).value).toBe("7");
    await user.click(
      await screen.findByRole("button", {
        name: "Загрузить актуальную настройку",
      }),
    );
    expect((threshold as HTMLInputElement).value).toBe("9");
    expect(save).toHaveBeenCalledWith({
      revision: 1,
      failed_logins: 7,
      window_seconds: 60,
      enabled: true,
    });
  });
  it("does not let an analyst edit the operating policy", async () => {
    auth.user.role = "analyst";
    vi.spyOn(api, "detectionPolicy").mockResolvedValue(policy);
    const user = setup(<DetectionPolicy />);
    await user.click(screen.getByText("Правило повторных входов"));
    expect(
      (
        (await screen.findByRole("button", {
          name: "Изменить правило",
        })) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it("exports the selected scope rather than the visible pagination and reports truncation", async () => {
    const exportCall = vi.spyOn(api, "iocExport").mockResolvedValue(result);
    const NativeURL = URL;
    vi.stubGlobal(
      "URL",
      class extends NativeURL {
        static createObjectURL() {
          return "blob:observed";
        }
        static revokeObjectURL() {}
      },
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    const user = setup(
      <ObservableExport
        filters={{ source_ip: "192.0.2.1", limit: 100, offset: 200 }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "IOC CSV / STIX" }));
    await user.click(
      screen.getByRole("button", { name: "Скачать наблюдения" }),
    );
    expect((await screen.findByRole("status")).textContent).toContain(
      "5000 событий из 5100",
    );
    expect(exportCall).toHaveBeenCalledWith({
      format: "stix",
      filters: { source_ip: "192.0.2.1", limit: 100, offset: 0 },
      session_id: null,
    });
    expect(click).toHaveBeenCalledOnce();
  });
  it("ignores a late export after closing the dialog", async () => {
    let resolve!: (value: typeof result) => void;
    vi.spyOn(api, "iocExport").mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    const user = setup(<ObservableExport sessionId="session" />);
    await user.click(screen.getByRole("button", { name: "IOC CSV / STIX" }));
    await user.click(
      screen.getByRole("button", { name: "Скачать наблюдения" }),
    );
    await user.keyboard("{Escape}");
    resolve(result);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(click).not.toHaveBeenCalled();
  });
  it("shows unavailable Geo/ASN instead of inventing a country for a private address", async () => {
    vi.spyOn(api, "geoSources").mockResolvedValue({
      city_database: {
        status: "unavailable",
        reason: "not_configured",
        built_at: null,
        database_type: null,
      },
      asn_database: {
        status: "unavailable",
        reason: "not_configured",
        built_at: null,
        database_type: null,
      },
      since: "2026-10-09T12:00:00Z",
      time_basis: "observed_at",
      interpretation: "Approximate",
      sources: [
        {
          source_ip: "192.0.2.1",
          status: "unavailable",
          reason: "private_or_reserved_address",
          event_count: 12,
        },
      ],
    });
    const user = setup(<GeoSources />);
    await user.click(screen.getByText("География источников"));
    expect(
      await screen.findByText("Локальный или зарезервированный адрес"),
    ).toBeTruthy();
    expect(screen.getByText("ASN: База не подключена")).toBeTruthy();
    expect(screen.queryByText("Москва")).toBeNull();
  });
  it("reports provider, age and stale state from actual Geo metadata", async () => {
    const database = {
      status: "available" as const,
      reason: null,
      built_at: "2026-01-01T00:00:00Z",
      database_type: "DBIP-City-Lite",
      provider: "DB-IP Lite",
      age_days: 283,
      stale: true,
    };
    vi.spyOn(api, "geoSources").mockResolvedValue({
      city_database: database,
      asn_database: {
        ...database,
        provider: null,
        age_days: null,
        stale: null,
      },
      since: "2026-10-10T12:00:00Z",
      time_basis: "observed_at",
      interpretation: "Approximate",
      sources: [],
    });
    const user = setup(<GeoSources />);
    await user.click(screen.getByText("География источников"));
    expect(
      await screen.findByText(
        /География: база доступна · DB-IP Lite · возраст 283 дн. · требуется обновление базы/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "DB-IP" }).getAttribute("href"),
    ).toBe("https://db-ip.com");
    expect(screen.getByText(/ASN: база доступна/).textContent).not.toContain(
      "возраст",
    );
  });
  it("keeps certificates admin-only and distinguishes pending confirmation from active TLS", async () => {
    const load = vi.spyOn(api, "hostCertificates").mockResolvedValue([
      {
        id: "certificate",
        host_id: "host",
        created_at: "2026-10-10T12:00:00Z",
        public_key_hash: "hash",
        fingerprint: "fingerprint",
        certificate_pem: "PUBLIC CERT",
        serial: "serial",
        state: "pending",
        expires_at: "2030-10-10T12:00:00Z",
        accept_until: "2030-10-10T12:00:00Z",
        confirmed_at: null,
        revoked_at: null,
      },
    ]);
    const revoke = vi.spyOn(api, "revokeCertificate");
    setup(<HostCertificates hostId="host" />);
    expect(screen.queryByText("Сертификаты агента")).toBeNull();
    expect(load).not.toHaveBeenCalled();
    cleanup();
    auth.user.role = "admin";
    const user = setup(<HostCertificates hostId="host" />);
    await user.click(screen.getByText("Сертификаты агента"));
    expect(await screen.findByText("Ожидает подтверждения")).toBeTruthy();
    expect(screen.getByText(/не доказывает.*mTLS/)).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Отозвать сертификат" }),
    );
    expect(revoke).not.toHaveBeenCalled();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Отмена",
      }),
    );
    expect(revoke).not.toHaveBeenCalled();
  });
  it("labels late historical findings without presenting a fresh LIVE alarm", () => {
    setup(
      <FindingTime
        finding={{
          notification_state: "historical",
          observed_first_at: "2026-10-01T12:00:00Z",
          observed_last_at: "2026-10-01T12:00:30Z",
        }}
      />,
    );
    expect(
      screen.getByText("Историческое срабатывание · без LIVE-тревоги"),
    ).toBeTruthy();
    expect(screen.queryByText("LIVE-тревога")).toBeNull();
  });
});
