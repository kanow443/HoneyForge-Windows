import type { BundleConfig, ProfileConfig } from "../../shared/api/models";
import { defaultConfig, validateDraft, type Adapter } from "./config";
export type BundleDraft = {
  name: string;
  description: string;
  config: BundleConfig;
};
export function defaultBundle(): BundleConfig {
  const http = defaultConfig("http"),
    ssh = defaultConfig("cowrie");
  return {
    schema_version: 3,
    adapter: "bundle",
    hostname: http.hostname,
    persona: http.persona,
    services: [
      { key: "web", port: http.recommended_port, config: http },
      { key: "ssh", port: ssh.recommended_port, config: ssh },
    ],
  };
}
export function bundleTotals(config: ProfileConfig) {
  const services =
    config.adapter === "bundle"
      ? config.services.map((s) => s.config)
      : [config];
  return {
    memory: services.reduce((n, c) => n + (c.limits?.memory_mb ?? 128), 0),
    cpu: services.reduce((n, c) => n + (c.limits?.cpu ?? 0.5), 0),
    files: services.reduce((n, c) => n + (c.decoy_files?.length ?? 0), 0),
  };
}
export function validateBundle(d: BundleDraft) {
  const errors: Record<string, string> = {};
  const root = validateDraft({
    name: d.name,
    description: d.description,
    config: {
      ...defaultConfig("http"),
      hostname: d.config.hostname,
      persona: d.config.persona,
    },
  });
  for (const key of ["name", "description", "hostname", "persona"])
    if (root[key]) errors[key] = root[key];
  if (d.config.services.length < 2 || d.config.services.length > 8)
    errors.services = "От 2 до 8 сервисов";
  const keys = new Set<string>(),
    ports = new Set<number>();
  d.config.services.forEach((s, i) => {
    if (!/^[a-z][a-z0-9-]{0,23}$/.test(s.key) || keys.has(s.key))
      errors[`service.${i}.key`] =
        "Уникальный ключ: латинские буквы, цифры, дефис; до 24 символов";
    keys.add(s.key);
    if (
      !Number.isInteger(s.port) ||
      s.port < 1024 ||
      s.port > 65535 ||
      ports.has(s.port)
    )
      errors[`service.${i}.port`] = "Уникальный порт от 1024 до 65535";
    ports.add(s.port);
    if (
      s.config.schema_version !== 2 ||
      !["http", "cowrie", "tcp-banner"].includes(
        s.config.adapter,
      )
    )
      errors[`service.${i}.config`] = "Нужен поддерживаемый сервис схемы v2";
    else
      for (const [key, value] of Object.entries(
        validateDraft({
          name: d.name,
          description: "",
          config: {
            ...s.config,
            hostname: d.config.hostname,
            persona: d.config.persona,
            recommended_port: s.port,
          },
        }),
      ))
        if (key !== "name") errors[`service.${i}.${key}`] = value;
  });
  return errors;
}
export function addBundleService(config: BundleConfig, adapter: Adapter) {
  if (config.services.length >= 8) return config;
  const child = defaultConfig(adapter);
  let key =
      adapter === "http" ? "web" : adapter.startsWith("cowrie") ? "ssh" : "tcp",
    n = 2;
  const base = key;
  while (config.services.some((s) => s.key === key)) key = base + "-" + n++;
  let port = child.recommended_port;
  while (config.services.some((s) => s.port === port)) port++;
  return {
    ...config,
    services: [
      ...config.services,
      { key, port, config: { ...child, recommended_port: port } },
    ],
  };
}
export function groupCompatible(original: BundleConfig, next: ProfileConfig) {
  return (
    next.adapter === "bundle" &&
    original.services.length === next.services.length &&
    original.services.every((s) =>
      next.services.some(
        (n) => n.key === s.key && n.config.adapter === s.config.adapter,
      ),
    )
  );
}
