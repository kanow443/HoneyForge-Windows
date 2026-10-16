import { describe, expect, it } from "vitest";
import {
  defaultConfig,
  validateDraft,
  upgradeConfig,
  levelLabel,
} from "./config";
import type { Config } from "../../shared/api/models";
describe("границы конструктора профиля", () => {
  it("оба шаблона дают допустимую конфигурацию", () => {
    for (const adapter of [
      "http",
      "cowrie",
      "tcp-banner",
    ] as const)
      expect(
        validateDraft({
          name: "Lab profile",
          description: "",
          config: defaultConfig(adapter),
        }),
      ).toEqual({});
  });
  it("classifies actual banner interaction as Low and service emulation as Medium, without guessing unknown adapters", () => {
    expect(levelLabel("tcp-banner")).toContain("Low");
    expect(levelLabel("http")).toContain("Medium");
    expect(levelLabel("cowrie")).toContain("Medium");
    expect(levelLabel("unknown")).toBe("Уровень не определён");
  });
  it("upgrades a cloned legacy draft without rewriting immutable v1 or losing its files", () => {
    const original: Config = {
      schema_version: 1,
      adapter: "http",
      template: "asset-console",
      hostname: "legacy-host",
      persona: "Legacy archive",
      server_banner: "nginx",
      limits: { memory_mb: 128, cpu: 0.5, pids: 64 },
      decoy_files: [
        { path: "/opt/decoy/legacy.txt", content: "legacy content" },
      ],
    };
    const upgraded = upgradeConfig(original);
    expect(upgraded.schema_version).toBe(2);
    expect(upgraded.recommended_port).toBe(18080);
    expect(original.schema_version).toBe(1);
    upgraded.decoy_files![0].content = "changed";
    expect(original.decoy_files![0].content).toBe("legacy content");
  });
  it("validates v2 synthetic accounts, collection quotas, beacon jitter and recommended ports", () => {
    const c = defaultConfig("cowrie");
    c.recommended_port = 22;
    c.decoy_accounts = [{ username: "bad user", password: "short" }];
    c.recording = {
      capture_credentials: true,
      http_payload_bytes: 8193,
      shell_output_bytes: 2,
    };
    c.beacon = { interval_seconds: 61, jitter_ratio: 0 };
    expect(
      validateDraft({ name: "Lab", description: "", config: c }),
    ).toMatchObject({
      recommended_port: expect.any(String),
      "account.0.username": expect.any(String),
      "account.0.password": expect.any(String),
      http_payload_bytes: expect.any(String),
      shell_output_bytes: expect.any(String),
      interval_seconds: expect.any(String),
      jitter_ratio: expect.any(String),
    });
  });
  it("rejects multiline Low banners and responses", () => {
    const c = defaultConfig("tcp-banner");
    if (c.adapter !== "tcp-banner") throw Error();
    c.banner = "SSH\nlogin";
    c.response = "Invalid\rrequest";
    expect(
      validateDraft({ name: "Lab", description: "", config: c }),
    ).toMatchObject({
      banner: expect.any(String),
      response: expect.any(String),
    });
  });
  it("отклоняет traversal и путь реального хоста", () => {
    for (const path of [
      "/opt/decoy/../secret",
      "/etc/passwd",
      "/home/user\\secret",
    ]) {
      const config = defaultConfig("http");
      config.decoy_files = [{ path, content: "" }];
      expect(
        validateDraft({ name: "Lab", description: "", config }),
      ).toHaveProperty("path.0");
    }
  });
  it("отклоняет повтор пути и oversized content", () => {
    const config = defaultConfig("cowrie");
    config.decoy_files = [
      { path: "/home/user/a", content: "" },
      { path: "/home/user/a", content: "x".repeat(8193) },
    ];
    const errors = validateDraft({ name: "Lab", description: "", config });
    expect(errors).toHaveProperty("path.1");
    expect(errors).toHaveProperty("content.1");
  });
  it("не допускает управляющие символы в легенде и лимиты за пределами", () => {
    const config = defaultConfig("http");
    config.persona = "Asset\nOps";
    config.limits = { memory_mb: 63, cpu: 2.1, pids: 257 };
    expect(validateDraft({ name: "", description: "", config })).toMatchObject({
      name: expect.any(String),
      persona: expect.any(String),
      memory_mb: expect.any(String),
      cpu: expect.any(String),
      pids: expect.any(String),
    });
  });
});
