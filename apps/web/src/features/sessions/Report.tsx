import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Download, Printer } from "lucide-react";
import { api } from "../../shared/api/client";
import { Code, ErrorNotice, Loading, PageHeader, time } from "../../shared/ui";
import { eventLabel, eventSummary, eventNote } from "../events/presentation";
import { ArtifactReference } from "../evidence/ArtifactReference";
import { PermissionNote, usePermissions } from "../auth/permissions";
import { BlockState } from "./SourceBlocks";
import { safePayload, terminalText } from "./playback";
import { verifyReport } from "./checksum";
import { TerminationResult } from "./TerminationResult";
import { ObservableExport } from "../analysis/ObservableExport";
import { FindingTime } from "../analysis/FindingTime";
const limitations: Record<string, string> = {
  "Source policies apply to the selected trap. SSH termination is a separate sensor acknowledgment; inspect termination_state and terminated_sessions.":
    "Ограничение относится к выбранной ловушке. Завершение SSH-сессий подтверждается сенсором отдельно; результат и идентификаторы указаны в ответных действиях.",
  "SSH commands and captured output describe an emulated shell, not the client's operating system.":
    "SSH-команды и сохранённый вывод относятся к эмулируемой среде. ОС клиента неизвестна.",
  "No terminal output was captured in this selected session history.":
    "В этой истории сессии нет сохранённых фрагментов вывода терминала.",
  "The session includes a sensor error or a terminal capture quota event; inspect the timeline for gaps.":
    "В сессии есть ошибка сенсора или превышение квоты записи вывода. Проверьте хронологию на пропуски.",
  "IP identifies an observed network source, not a person; client OS is unknown.":
    "IP обозначает наблюдаемый сетевой источник. Личность и ОС клиента неизвестны.",
  "SSH commands describe interaction with an emulated shell; terminal output is not captured.":
    "SSH-команды относятся к эмулируемой среде. Вывод терминала не записывается.",
  "Intent findings are distinguished from observed network activity.":
    "Намерение в эмуляторе отличается от наблюдаемой сетевой активности.",
  "Source policies block new connections to the selected trap; existing sessions are not terminated.":
    "Ограничения блокируют новые подключения к выбранной ловушке. Открытые сессии не завершаются.",
  "SHA-256 checks content integrity and is not a digital signature.":
    "SHA-256 проверяет совпадение содержимого; это не цифровая подпись.",
  "Event selection is truncated to 5000 records.":
    "Выборка событий ограничена 5000 записями.",
  "Related audit selection is truncated to 200 records.":
    "История действий оператора ограничена 200 записями.",
};
export function ReportPage() {
  const { can } = usePermissions();
  const { id } = useParams(),
    q = useQuery({
      queryKey: ["report", id],
      queryFn: () => api.report(id!),
      staleTime: 0,
    }),
    [checksum, setChecksum] = useState<
      "checking" | "valid" | "invalid" | "unavailable"
    >("checking");
  useEffect(() => {
    let disposed = false;
    setChecksum("checking");
    if (q.data)
      void verifyReport(q.data.raw, q.data.document.sha256)
        .then((result) => {
          if (!disposed) setChecksum(result.valid ? "valid" : "invalid");
        })
        .catch(() => {
          if (!disposed) setChecksum("unavailable");
        });
    return () => {
      disposed = true;
    };
  }, [q.data]);
  if (q.isPending) return <Loading />;
  if (q.error)
    return <ErrorNotice error={q.error} onRetry={() => q.refetch()} />;
  const r = q.data.document;
  function download() {
    const url = URL.createObjectURL(
      new Blob([q.data!.raw], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `honeyforge-report-${id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="session-report">
      <Link className="back-link no-print" to={`/sessions/${id}`}>
        <ArrowLeft size={14} />К плееру сессии
      </Link>
      <PageHeader
        title="Отчёт расследования"
        description={`${r.session.source_ip} · ${r.deployment.name}`}
        action={
          <>
            <button
              className="button"
              disabled={!can("investigate")}
              onClick={download}
            >
              <Download size={15} />
              JSON
            </button>
            <ObservableExport sessionId={id} />
            <button
              className="button primary"
              disabled={!can("investigate")}
              onClick={() => window.print()}
            >
              <Printer size={15} />
              Печать / PDF
            </button>
          </>
        }
      />
      <PermissionNote permission="investigate" />
      <div className="report-document">
        <header className="report-cover">
          <span>HoneyForge · Наблюдение и доказательства</span>
          <h2>{r.session.source_ip}</h2>
          <p>
            {r.deployment.name} · {r.session.protocol.toUpperCase()} ·{" "}
            {r.deployment.endpoint}
          </p>
          <div>
            <span>
              Наблюдение: {time(r.session.started_at, true)} —{" "}
              {r.session.ended_at
                ? time(r.session.ended_at, true)
                : "Окончание не получено"}
            </span>
            <span>Отчёт сформирован: {time(r.generated_at, true)}</span>
          </div>
        </header>
        <div className="report-summary">
          <div>
            <span>События</span>
            <strong>
              {r.events.length}
              {r.truncated ? ` из ${r.total}` : ""}
            </strong>
          </div>
          <div>
            <span>Срабатывания</span>
            <strong>{r.findings.length}</strong>
          </div>
          <div>
            <span>Версия приманки</span>
            <strong>v{r.profile_version.number}</strong>
          </div>
          <div>
            <span>Сбор данных</span>
            <strong>
              {{
                online: "На связи",
                offline: "Не в сети",
                degraded: "С ограничениями",
                revoked: "Отозван",
              }[r.collection.host_status] ?? r.collection.host_status}
            </strong>
          </div>
        </div>
        {r.truncated && (
          <p className="info-note warn">
            Выборка неполная: {r.events.length} из {r.total} событий. Это
            ограничение включено в отчёт.
          </p>
        )}
        <section>
          <h2>Применённая приманка</h2>
          <dl className="report-properties">
            <dt>Профиль</dt>
            <dd>
              {r.deployment.profile_name} · v{r.profile_version.number}
            </dd>
            <dt>Имя машины</dt>
            <dd>{r.profile_version.config.hostname}</dd>
            <dt>Легенда</dt>
            <dd>{r.profile_version.config.persona}</dd>
            <dt>Хеш конфигурации</dt>
            <dd>
              <code>{r.profile_version.config_hash}</code>
            </dd>
            <dt>Сессия</dt>
            <dd>
              <code>{r.session.id}</code>
            </dd>
            <dt>Поколение запуска</dt>
            <dd>
              <code>{r.session.generation}</code>
            </dd>
          </dl>
        </section>
        <section>
          <h2>Причины обнаружения</h2>
          {r.findings.length ? (
            r.findings.map((f) => (
              <article className="report-finding" key={f.id}>
                <div>
                  <strong>{f.title}</strong>
                  <FindingTime finding={f} />
                  <span className={`finding-severity severity-${f.severity}`}>
                    {{ high: "Высокая", medium: "Средняя", low: "Низкая" }[
                      f.severity
                    ] ?? f.severity}{" "}
                    важность
                  </span>
                </div>
                <p>{f.explanation}</p>
                <small>
                  {f.observation === "intent"
                    ? "Намерение в эмуляторе"
                    : "Наблюдаемое действие"}{" "}
                  · {f.rule_id} · версия {f.rule_version}
                </small>
                <ul>
                  {f.evidence_ids.map((evidence) => {
                    const event = r.events.find(
                      (e) => e.id === evidence || e.event_id === evidence,
                    );
                    return (
                      <li key={evidence}>
                        {event ? (
                          <a href={`#report-event-${event.id}`}>
                            {eventLabel(event.event_type)} ·{" "}
                            {time(event.observed_at)}
                            <code>{evidence}</code>
                          </a>
                        ) : (
                          <span>
                            Событие вне выборки <code>{evidence}</code>
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </article>
            ))
          ) : (
            <p>Срабатываний правил не сохранено.</p>
          )}
        </section>
        <section>
          <h2>Хронология наблюдений</h2>
          <div className="report-events">
            {r.events.map((e) => (
              <article key={e.id} id={`report-event-${e.id}`}>
                <div>
                  <time>{time(e.observed_at, true)}</time>
                  <strong>{eventLabel(e.event_type)}</strong>
                </div>
                <pre>
                  {terminalText(
                    eventSummary({
                      ...e,
                      payload: safePayload(e.payload) as Record<
                        string,
                        unknown
                      >,
                    }),
                  ) || eventLabel(e.event_type)}
                </pre>
                {eventNote(e.event_type) && <p>{eventNote(e.event_type)}</p>}
                <ArtifactReference event={e} />
                <small>
                  Получено {time(e.created_at, true)} · {e.provenance}
                </small>
                <code>Evidence ID: {e.id}</code>
                <details className="no-print">
                  <summary>Содержимое события</summary>
                  <Code value={safePayload(e.payload)} />
                </details>
              </article>
            ))}
          </div>
        </section>
        <section>
          <h2>Ответные действия</h2>
          {r.source_blocks.length ? (
            r.source_blocks.map((b) => (
              <article className="report-response" key={b.id}>
                <div>
                  <code>{b.source_ip}</code>
                  <BlockState block={b} snapshot />
                </div>
                <p>{b.reason}</p>
                <small>
                  Создано {time(b.created_at, true)} · до{" "}
                  {time(b.expires_at, true)} · {b.created_by}
                </small>
                <small>
                  Подтверждение агента: {time(b.observed_at, true)} · ревизия{" "}
                  {b.observed_revision} из {b.revision}
                </small>
                {b.error && <p>{b.error}</p>}
                {r.session.protocol === "ssh" && (
                  <TerminationResult block={b} />
                )}
                <code>Политика: {b.id}</code>
              </article>
            ))
          ) : (
            <p>Ограничения для этого источника и запуска не запрашивались.</p>
          )}
        </section>
        <section>
          <h2>История оператора</h2>
          {r.audit.length ? (
            r.audit.map((a) => (
              <div className="report-audit" key={a.id}>
                <time>{time(a.created_at, true)}</time>
                <strong>{a.action}</strong>
                <span>{a.actor}</span>
                <code>{a.object_id}</code>
              </div>
            ))
          ) : (
            <p>Связанных действий в выборке нет.</p>
          )}
        </section>
        <section>
          <h2>Качество сбора и ограничения</h2>
          <p>
            Водяной знак сохранённых данных: {r.collection.watermark}. В очереди
            агента: {String(r.collection.metrics.queued_events ?? "неизвестно")}
            ; отброшено:{" "}
            {String(r.collection.metrics.dropped_events ?? "неизвестно")}.
          </p>
          <ul>
            {r.limitations.map((item) => (
              <li key={item}>{limitations[item] ?? item}</li>
            ))}
          </ul>
        </section>
        <footer className="report-integrity">
          <h2>Целостность содержимого</h2>
          <p
            key={checksum}
            className={
              checksum === "valid"
                ? "good motion-feedback"
                : checksum === "invalid"
                  ? "bad motion-feedback"
                  : "motion-feedback"
            }
            role="status"
          >
            {
              {
                checking: "Проверяем контрольную сумму…",
                valid: "SHA-256 совпадает с содержимым полученного отчёта",
                invalid: "Контрольная сумма не совпадает",
                unavailable: "Проверка в этом браузере недоступна",
              }[checksum]
            }
          </p>
          <code>{r.sha256}</code>
          <small>
            Канонический JSON без поля sha256: ключи отсортированы, UTF-8, без
            пробелов. Контрольная сумма не подтверждает авторство.
          </small>
        </footer>
      </div>
    </div>
  );
}
