import type { Filters } from "../../shared/api/models";
export const eventTypes = [
  "http.request",
  "http.login",
  "ssh.connect",
  "ssh.login.failed",
  "ssh.login.success",
  "ssh.command",
  "ssh.output",
  "ssh.client.version",
  "ssh.client.kex",
  "ssh.file.download",
  "ssh.file.download.failed",
  "ssh.file.upload",
  "ssh.disconnect",
  "ssh.forward",
  "network.blocked",
  "sensor.error",
];
export function eventFilters(params: URLSearchParams): Filters {
  const result: Filters = {
    limit: 100,
    offset: Math.max(0, Number(params.get("offset")) || 0),
  };
  for (const k of [
    "host_id",
    "deployment_id",
    "event_type",
    "source_ip",
    "q",
    "since",
    "until",
  ] as const) {
    const value = params.get(k);
    if (value) result[k] = value;
  }
  const flag = params.get("flag");
  if (flag === "suspicious" || flag === "reviewed" || flag === "false_positive" || flag === "escalated") result.flag = flag;
  return result;
}
export function setFilter(params: URLSearchParams, key: string, value: string) {
  const p = new URLSearchParams(params);
  value ? p.set(key, value) : p.delete(key);
  if (key !== "event") p.delete("offset");
  return p;
}
