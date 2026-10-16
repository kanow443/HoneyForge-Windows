import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, RefreshCw } from "lucide-react";
import { api, errorText } from "../../shared/api/client";
import type { Artifact } from "../../shared/api/models";
import { Code, ErrorNotice, Loading, time } from "../../shared/ui";
import { byteSize, saveArtifact, verifiedArtifactBytes } from "./download";
import { PermissionNote, usePermissions } from "../auth/permissions";

type Scope =
  | { sessionId: string; deploymentId?: never }
  | { deploymentId: string; sessionId?: never };
export function EvidenceList({
  sessionId,
  deploymentId,
  selected,
}: Scope & { selected?: string | null }) {
  const [limit, setLimit] = useState(8);
  const q = useQuery({
    queryKey: [
      "artifacts",
      sessionId ? "session" : "deployment",
      sessionId ?? deploymentId,
    ],
    queryFn: ({ signal }) =>
      api.artifacts(
        sessionId
          ? { session_id: sessionId }
          : { deployment_id: deploymentId! },
        signal,
      ),
    refetchInterval: 10000,
  });
  useEffect(() => setLimit(8), [sessionId, deploymentId]);
  const rows = q.data ?? [],
    focused = rows.find((a) => a.id === selected),
    ordered = focused
      ? [focused, ...rows.filter((a) => a.id !== selected)]
      : rows;
  return (
    <section
      className="evidence-list"
      id="evidence"
      aria-label="Доказательства"
    >
      <div className="section-heading">
        <div>
          <h2>Доказательства</h2>
          <p>
            {sessionId
              ? "Файлы сессии и сетевые записи, пересекающие её время."
              : "Сохранённые файлы и сетевые записи этой ловушки."}
          </p>
        </div>
        <PermissionNote permission="investigate" />
        <button
          className="button"
          disabled={q.isFetching}
          onClick={() => q.refetch()}
        >
          <RefreshCw size={14} />
          <span>Обновить</span>
        </button>
      </div>
      <ErrorNotice error={q.error} onRetry={() => q.refetch()} />
      {q.isPending ? (
        <Loading />
      ) : (
        <>
          {!q.error && rows.length === 0 && (
            <p className="quiet-empty">Сохранённых доказательств пока нет.</p>
          )}
          {!q.error && selected && !focused && (
            <p className="info-note">Сведения о связанном файле не получены.</p>
          )}
          {ordered.slice(0, limit).map((artifact) => (
            <ArtifactRow
              key={artifact.id}
              artifact={artifact}
              selected={artifact.id === selected}
            />
          ))}
          {rows.length > limit && (
            <button
              className="button evidence-more"
              onClick={() => setLimit((n) => n + 8)}
            >
              Показать ещё ({rows.length - limit})
            </button>
          )}
          {rows.length === 200 && (
            <p className="panel-note">Список ограничен 200 записями.</p>
          )}
        </>
      )}
    </section>
  );
}

function ArtifactRow({
  artifact: a,
  selected,
}: {
  artifact: Artifact;
  selected: boolean;
}) {
  const { can } = usePermissions();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [verified, setVerified] = useState(false);
  async function download() {
    setBusy(true);
    setError(null);
    setVerified(false);
    try {
      const bytes = await verifiedArtifactBytes(a);
      saveArtifact(bytes, a);
      setVerified(true);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  const title = {
      pcap: "Сетевая запись",
      file: "Сохранённый файл",
      terminal: "Запись терминала",
    }[a.kind],
    state = {
      receiving: "Принимается",
      available: "Доступно",
      expired: "Срок хранения истёк",
      purging: "Удаляется",
    }[a.state],
    progress = Math.min(Math.max(a.received_bytes, 0), a.size_bytes);
  return (
    <article
      className={`artifact-row${selected ? " selected" : ""}`}
      id={`artifact-${a.id}`}
    >
      <div className="artifact-heading">
        <div>
          <h3>
            {title}
            {a.kind === "pcap" && <span className="artifact-format">PCAP</span>}
          </h3>
          <p>
            {time(a.started_at, true)}
            {a.started_at !== a.ended_at && ` — ${time(a.ended_at)}`}
          </p>
        </div>
        <div className="artifact-action">
          <span className={`artifact-state ${a.state}`}>{state}</span>
          {a.state === "available" && can("investigate") && (
            <button
              className="button"
              onClick={download}
              disabled={busy}
              aria-label={`Скачать ${{ pcap: "сетевую запись", file: "сохранённый файл", terminal: "запись терминала" }[a.kind]} ${a.id}`}
            >
              <Download size={14} />
              {busy ? "Проверяем файл…" : "Скачать"}
            </button>
          )}
        </div>
      </div>
      {a.state === "receiving" ? (
        <div className="artifact-progress">
          <progress
            max={a.size_bytes}
            value={progress}
            aria-label={`Приём доказательства ${a.id}`}
          />
          <span>
            Получено {byteSize(a.received_bytes)} из {byteSize(a.size_bytes)}
          </span>
        </div>
      ) : (
        <p className="artifact-size">
          {byteSize(a.size_bytes)}
          {a.state === "available" && " · SHA-256 проверен сервером"}
        </p>
      )}
      {a.kind === "pcap" && (
        <p className="artifact-scope">
          Запись сети всей ловушки, включая другие подключения. SSH-трафик
          остаётся зашифрованным; команды доступны в плеере сессии.
        </p>
      )}
      {a.kind === "file" && (
        <p className="artifact-scope">
          {a.details?.malware_verdict === "not_scanned"
            ? "Проверка на вредоносность не проводилась."
            : "Заключение о вредоносности не предоставлено."}
        </p>
      )}
      {a.state === "expired" && (
        <p className="artifact-scope">
          Содержимое больше недоступно для скачивания. Метаданные записи
          сохранены.
        </p>
      )}
      {error && (
        <p className="bad" role="alert">
          {error}
        </p>
      )}
      {verified && (
        <p className="artifact-verified" role="status">
          SHA-256 и размер полученного файла совпадают. Файл передан браузеру
          для сохранения.
        </p>
      )}
      <details open={selected || undefined} className="artifact-details">
        <summary>Сведения о доказательстве</summary>
        <dl>
          <dt>SHA-256{a.state === "receiving" ? " (заявлен сенсором)" : ""}</dt>
          <dd>
            <code>{a.sha256}</code>
          </dd>
          <dt>Размер в байтах</dt>
          <dd>{a.size_bytes.toLocaleString("ru-RU")}</dd>
          <dt>Срок хранения</dt>
          <dd>{time(a.expires_at, true)}</dd>
          <dt>Идентификатор</dt>
          <dd>
            <code>{a.id}</code>
          </dd>
          <dt>Поколение запуска</dt>
          <dd>
            <code>{a.generation}</code>
          </dd>
          {a.source_session_id && (
            <>
              <dt>Сессия сенсора</dt>
              <dd>
                <code>{a.source_session_id}</code>
              </dd>
            </>
          )}
        </dl>
        {a.details && Object.keys(a.details).length > 0 && (
          <details>
            <summary>Данные сенсора</summary>
            <Code value={a.details} />
          </details>
        )}
      </details>
    </article>
  );
}
