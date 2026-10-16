import { describe, it, expect } from "vitest";
import {
  addBundleService,
  bundleTotals,
  defaultBundle,
  groupCompatible,
  validateBundle,
} from "./bundle";
import { defaultConfig } from "./config";
describe("multi-service profile invariants", () => {
  it("rejects duplicate keys and ports, out-of-range ports, and invalid individual v2 settings", () => {
    const config = defaultBundle();
    config.services[1].key = "web";
    config.services[1].port = config.services[0].port;
    config.services[0].config.limits!.memory_mb = 2;
    const errors = validateBundle({ name: "Bundle", description: "", config });
    expect(errors["service.1.key"]).toBeTruthy();
    expect(errors["service.1.port"]).toBeTruthy();
    expect(errors["service.0.memory_mb"]).toBeTruthy();
    config.services[1].port = 65536;
    expect(
      validateBundle({ name: "Bundle", description: "", config })[
        "service.1.port"
      ],
    ).toBeTruthy();
  });
  it("adds a distinct service without mutating published input and enforces maximum eight", () => {
    const original = defaultBundle(),
      serialized = JSON.stringify(original);
    let config = original;
    for (let i = 0; i < 10; i++) config = addBundleService(config, "http");
    expect(config.services).toHaveLength(8);
    expect(new Set(config.services.map((s) => s.key)).size).toBe(8);
    expect(new Set(config.services.map((s) => s.port)).size).toBe(8);
    expect(JSON.stringify(original)).toBe(serialized);
    expect(bundleTotals(config).memory).toBe(1024);
  });
  it("uses shared hostname and persona for child validation and rejects topology changes for group redeploy", () => {
    const config = defaultBundle();
    config.services[0].config.hostname = "invalid hostname";
    expect(validateBundle({ name: "Bundle", description: "", config })).toEqual(
      {},
    );
    const reordered = { ...config, services: [...config.services].reverse() };
    expect(groupCompatible(config, reordered)).toBe(true);
    reordered.services = [
      { ...config.services[0], config: defaultConfig("tcp-banner") },
      config.services[1],
    ];
    expect(groupCompatible(config, reordered)).toBe(false);
    expect(groupCompatible(config, defaultConfig("http"))).toBe(false);
  });
});
