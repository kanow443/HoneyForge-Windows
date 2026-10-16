import type { Config, ConfigV2 } from "../../shared/api/models";
export type Adapter = Config["adapter"];
export const adapterLabels: Record<Adapter, string> = {
  http: "HTTP-портал",
  cowrie: "SSH (Cowrie)",
  "tcp-banner": "TCP-баннер",
};
export const adapterPorts: Record<Adapter, number> = {
  http: 18080,
  cowrie: 2222,
  "tcp-banner": 2223,
};
export function adapterLabel(adapter: string) {
  if (adapter === "bundle") return "Несколько сервисов";
  return adapterLabels[adapter as Adapter] ?? adapter;
}
export function levelLabel(adapter: string) {
  if (adapter === "bundle")
    return "Уровень указан отдельно для каждого сервиса";
  return adapter === "tcp-banner"
    ? "Low · баннер без логики сервиса"
    : ["http", "cowrie"].includes(adapter)
      ? "Medium · эмуляция сервиса"
      : "Уровень не определён";
}
export type ProfileDraft = {
  name: string;
  description: string;
  config: Config;
};
export function defaultConfig(adapter: Adapter): ConfigV2 {
  const common = {
    schema_version: 2 as const,
    recommended_port: adapterPorts[adapter],
    decoy_accounts: [{ username: "demo.user", password: "hackathon-demo" }],
    recording: {
      capture_credentials: true,
      http_payload_bytes: 8192,
      shell_output_bytes: 262144,
    },
    beacon: { interval_seconds: 5, jitter_ratio: 0.2 },
    hostname: "files-stage-02",
    persona: "Asset Operations",
    decoy_files: [
      {
        path: "/opt/decoy/backup-notes.txt",
        content:
          "Synthetic staging backup inventory\nLast archive: backup-stage.tar.gz",
      },
    ],
    limits: { memory_mb: 128, cpu: 0.5, pids: 64 },
  };
  return adapter === "http"
    ? { ...common, adapter, template: "asset-console", server_banner: "nginx" }
    : adapter === "tcp-banner"
      ? {
          ...common,
          adapter,
          decoy_files: [],
          banner: "SSH-2.0-OpenSSH_8.9p1",
          response: "Protocol mismatch.",
        }
      : {
          ...common,
          adapter,
          ssh_banner: "SSH-2.0-OpenSSH_8.9p1 Ubuntu-3",
          download_mode: "blocked",
        };
}
export function upgradeConfig(config: Config): ConfigV2 {
  return {
    ...defaultConfig(config.adapter),
    ...structuredClone(config),
    schema_version: 2,
  } as ConfigV2;
}
export function validateDraft(d: ProfileDraft) {
  const errors: Record<string, string> = {};
  if (!d.name.trim() || d.name.length > 100)
    errors.name = "Укажите название профиля, до 100 символов";
  if (d.description.length > 500) errors.description = "Не более 500 символов";
  if (d.config.schema_version === 2) {
    const c = d.config;
    if (
      !Number.isInteger(c.recommended_port) ||
      c.recommended_port < 1024 ||
      c.recommended_port > 65535
    )
      errors.recommended_port = "Порт от 1024 до 65535";
    const accounts = c.decoy_accounts;
    if (accounts && (accounts.length < 1 || accounts.length > 8))
      errors.accounts = "От 1 до 8 синтетических учётных записей";
    const names = new Set<string>();
    accounts?.forEach((a, i) => {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(a.username) || names.has(a.username))
        errors[`account.${i}.username`] =
          "Уникальное имя: 1–64 латинских букв, цифр, _ . -";
      names.add(a.username);
      if (!/^[A-Za-z0-9_.@-]{8,128}$/.test(a.password))
        errors[`account.${i}.password`] =
          "Синтетический пароль: 8–128 символов A–Z, a–z, 0–9, _ . @ -";
    });
    if (c.recording) {
      if (
        !Number.isInteger(c.recording.http_payload_bytes) ||
        c.recording.http_payload_bytes < 0 ||
        c.recording.http_payload_bytes > 8192
      )
        errors.http_payload_bytes = "От 0 до 8192 байт";
      if (
        !Number.isInteger(c.recording.shell_output_bytes) ||
        c.recording.shell_output_bytes < 16384 ||
        c.recording.shell_output_bytes > 1048576
      )
        errors.shell_output_bytes = "От 16384 до 1048576 байт";
    }
    if (c.beacon) {
      if (
        !Number.isFinite(c.beacon.interval_seconds) ||
        c.beacon.interval_seconds < 1 ||
        c.beacon.interval_seconds > 60
      )
        errors.interval_seconds = "От 1 до 60 секунд";
      if (
        !Number.isFinite(c.beacon.jitter_ratio) ||
        c.beacon.jitter_ratio < 0.1 ||
        c.beacon.jitter_ratio > 0.5
      )
        errors.jitter_ratio = "От 0,1 до 0,5";
    }
  }
  if (d.config.adapter === "tcp-banner") {
    if (
      !d.config.banner.trim() ||
      d.config.banner.length > 256 ||
      /[\r\n\x00-\x1f]/.test(d.config.banner)
    )
      errors.banner = "Баннер: одна строка, 1–256 символов";
    if (
      d.config.response.length > 256 ||
      /[\r\n\x00-\x1f]/.test(d.config.response)
    )
      errors.response = "Ответ: одна строка до 256 символов";
  }
  if (
    d.config.adapter === "http" &&
    !/^[A-Za-z0-9 ./_-]{1,64}$/.test(d.config.server_banner)
  )
    errors.server_banner = "До 64 латинских букв, цифр и символов . / _ -";
  if (
    d.config.adapter === "cowrie" &&
    !/^SSH-2\.0-[A-Za-z0-9 ._-]{1,80}$/.test(d.config.ssh_banner)
  )
    errors.ssh_banner = "Формат SSH-2.0-… и до 80 символов после префикса";
  if (
    d.config.adapter === "cowrie" &&
    d.config.download_mode !== undefined &&
    !["blocked", "fixture"].includes(d.config.download_mode)
  )
    errors.download_mode =
      "Выберите запрещённую загрузку или лабораторный образец";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}$/.test(d.config.hostname ?? ""))
    errors.hostname = "Используйте до 63 букв, цифр, точек и дефисов";
  if (
    !d.config.persona?.trim() ||
    d.config.persona.length > 80 ||
    /[\x00-\x1f]/.test(d.config.persona)
  )
    errors.persona = "Легенда: 1–80 символов обычного текста";
  const paths = new Set<string>();
  d.config.decoy_files?.forEach((f, i) => {
    if (
      f.path.length > 160 ||
      !/^\/(home|var\/www|opt\/decoy)\//.test(f.path) ||
      f.path.split("/").includes("..") ||
      /[\\\x00]/.test(f.path)
    )
      errors[`path.${i}`] =
        "Абсолютный путь внутри /home/, /var/www/ или /opt/decoy/ без ..";
    const normalized =
      "/" +
      f.path
        .split("/")
        .filter((p) => p && p !== ".")
        .join("/");
    if (paths.has(normalized))
      errors[`path.${i}`] = "Пути должны быть уникальными";
    paths.add(normalized);
    if (f.content.length > 8192)
      errors[`content.${i}`] = "Не более 8192 символов";
  });
  if ((d.config.decoy_files?.length ?? 0) > 12)
    errors.files = "Не более 12 файлов";
  const limits = d.config.limits;
  if (limits) {
    if (
      !Number.isInteger(limits.memory_mb) ||
      limits.memory_mb! < 64 ||
      limits.memory_mb! > 512
    )
      errors.memory_mb = "От 64 до 512 MB";
    if (!Number.isFinite(limits.cpu) || limits.cpu! < 0.1 || limits.cpu! > 2)
      errors.cpu = "От 0,1 до 2 CPU";
    if (
      !Number.isInteger(limits.pids) ||
      limits.pids! < 32 ||
      limits.pids! > 256
    )
      errors.pids = "От 32 до 256 PID";
  }
  return errors;
}
