import { api } from "../../shared/api/client";
import type { Artifact } from "../../shared/api/models";

export async function verifiedArtifactBytes(artifact: Artifact) {
  if (artifact.state !== "available")
    throw new Error("Содержимое доказательства пока недоступно.");
  const result = await api.artifactBytes(artifact.id);
  if (result.bytes.byteLength !== artifact.size_bytes)
    throw new Error(
      "Размер полученного файла не совпадает с записью доказательства. Скачивание остановлено.",
    );
  if (result.sha256 !== artifact.sha256)
    throw new Error(
      "Контрольная сумма ответа не совпадает с записью доказательства. Скачивание остановлено.",
    );
  if (!crypto.subtle)
    throw new Error(
      "Браузер не поддерживает проверку SHA-256. Откройте приложение через HTTPS или localhost.",
    );
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", result.bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (hash !== artifact.sha256)
    throw new Error(
      "SHA-256 полученного файла не совпадает с записью доказательства. Скачивание остановлено.",
    );
  return result.bytes;
}

export function saveArtifact(bytes: ArrayBuffer, artifact: Artifact) {
  const url = URL.createObjectURL(
    new Blob([bytes], { type: "application/octet-stream" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${artifact.kind}-${artifact.id}.${artifact.kind === "pcap" ? "pcap" : "bin"}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function byteSize(bytes: number) {
  if (bytes < 1024) return `${bytes.toLocaleString("ru-RU")} Б`;
  const unit = bytes < 1024 * 1024 ? "КиБ" : "МиБ";
  const value = bytes / (unit === "КиБ" ? 1024 : 1024 * 1024);
  return `${value.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ${unit}`;
}
