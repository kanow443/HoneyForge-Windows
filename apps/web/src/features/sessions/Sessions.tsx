import { useState, useRef, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, Ban, FileText } from "lucide-react";
import { api } from "../../shared/api/client";
import type { PlaybackHistory } from "../../shared/api/models";
import {
  Code,
  ErrorNotice,
  KeyValue,
  Loading,
  PageHeader,
  time,
} from "../../shared/ui";
import { useLive } from "../../app/LiveProvider";
import { SessionPlayer } from "./SessionPlayer";
import { SourceBlocks } from "./SourceBlocks";
import { CreateCase } from "./Cases";
import { loadHistory } from "./playback";
import { MotionIndicator } from "../../shared/ui/motion";
import { EvidenceList } from "../evidence/EvidenceList";
import { usePermissions } from "../auth/permissions";
import { GeoSources } from "../analysis/GeoSources";

export function SessionPage() {
  const { id } = useParams();
  return <SessionWorkspace key={id} id={id!} />;
}
function SessionWorkspace({ id }: { id: string }) {
  const { can } = usePermissions();
  const client = useQueryClient(),
    live = useLive(),
    [params, setParams] = useSearchParams(),
    [view, setView] = useState(params.has("artifact") ? "evidence" : "player");
  const selectedArtifact = params.get("artifact");
  useEffect(() => {
    if (selectedArtifact) setView("evidence");
  }, [selectedArtifact]);
  const q = useQuery({
    queryKey: ["session", id],
    queryFn: () => api.session(id),
    refetchInterval: 10000,
  });
  const resetAt = useRef(live.reset);
  const history = useQuery({
    queryKey: ["playback", id],
    queryFn: async ({ signal }) => {
      const data = await loadHistory(
        id,
        resetAt.current === live.reset
          ? client.getQueryData<PlaybackHistory>(["playback", id])
          : undefined,
        signal,
      );
      resetAt.current = live.reset;
      return data;
    },
    refetchInterval: 5000,
  });
  useEffect(() => {
    if (resetAt.current !== live.reset)
      void client.invalidateQueries({ queryKey: ["playback", id] });
  }, [live.reset, client, id]);
  const hosts = useQuery({
      queryKey: ["hosts"],
      queryFn: api.hosts,
      refetchInterval: 10000,
    }),
    deployment = useQuery({
      queryKey: ["deployment", q.data?.deployment_id],
      queryFn: () => api.deployment(q.data!.deployment_id),
      enabled: Boolean(q.data),
      refetchInterval: 10000,
    });
  if (q.isPending) return <Loading />;
  if (q.error)
    return <ErrorNotice error={q.error} onRetry={() => q.refetch()} />;
  const s = q.data,
    events = history.data?.items ?? [],
    host = hosts.data?.find((h) => h.id === deployment.data?.host_id);
  function finding(id: string | null) {
    setParams((old) => {
      const next = new URLSearchParams(old);
      if (id) next.set("finding", id);
      else next.delete("finding");
      return next;
    });
  }
  return (
    <div className="session-workspace">
      <Link
        className="back-link"
        to={`/events?deployment_id=${s.deployment_id}`}
      >
        <ArrowLeft size={14} />К событиям ловушки
      </Link>
      <PageHeader
        title={`Сессия ${s.source_ip}`}
        description={`${s.deployment_name} · ${s.protocol.toUpperCase()} · ${time(s.started_at, true)}`}
        action={
          <>
            <button
              className="button"
              disabled={!can("operate")}
              title={
                !can("operate")
                  ? "Доступно оператору и администратору"
                  : undefined
              }
              onClick={() => setView("response")}
            >
              <Ban size={15} />
              Ограничить источник
            </button>
            <Link className="button primary" to={`/sessions/${id}/report`}>
              <FileText size={15} />
              Отчёт
            </Link>
          </>
        }
      />
      <div className="player-session-meta">
        <Link to={`/traps/${s.deployment_id}`}>
          <code>{deployment.data?.endpoint ?? s.deployment_name}</code>
        </Link>
        <span>
          Приманка v{s.profile_version.number} ·{" "}
          {s.profile_version.config.hostname}
        </span>
        <span>{s.event_count} событий</span>
        <span>{s.ended_at ? "Сессия завершена" : "Окончание не получено"}</span>
      </div>
      {host?.status === "offline" ||
      host?.status === "revoked" ||
      host?.status === "degraded" ||
      host?.metrics.dropped_events ||
      host?.metrics.parser_errors ? (
        <div className="info-note warn">
          Сбор:{" "}
          {host?.status === "revoked"
            ? "ключ сенсора отозван"
            : host?.status === "offline"
              ? "сенсор не в сети"
              : host?.status === "degraded"
                ? "сенсор работает с ограничениями"
                : "есть ошибки сбора"}
          . Отброшено: {host?.metrics.dropped_events ?? "неизвестно"}, ошибки
          разбора: {host?.metrics.parser_errors ?? "неизвестно"}. Сохранённая
          история доступна.
        </div>
      ) : null}
      <ErrorNotice error={history.error} onRetry={() => history.refetch()} />
      <ErrorNotice error={deployment.error} />
      <ErrorNotice error={hosts.error} />
      {history.data && history.data.items.length < history.data.total && (
        <div className="info-note warn">
          История неполная: {history.data.items.length} из {history.data.total}.
          Повторите загрузку.
        </div>
      )}
      <div
        className="investigation-tabs"
        role="group"
        aria-label="Разделы расследования"
      >
        <MotionIndicator active={view} />
        {[
          ["player", "Плеер сессии"],
          ["evidence", "Доказательства"],
          ["response", "Ответные действия"],
          ["context", "Дело и контекст"],
        ].map(([key, label]) => (
          <button
            key={key}
            className={view === key ? "active" : ""}
            onClick={() => setView(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div hidden={view !== "player"}>
        {history.isPending ? (
          <Loading />
        ) : (
          <SessionPlayer
            events={events}
            findings={s.findings}
            selected={params.get("finding")}
            onFinding={finding}
            connection={live.status}
            ended={Boolean(s.ended_at)}
            catchUp={() => history.refetch({ throwOnError: true })}
            fetching={history.isFetching}
            lastReceived={events.reduce<string | undefined>(
              (latest, event) =>
                !latest || event.created_at > latest
                  ? event.created_at
                  : latest,
              undefined,
            )}
          />
        )}
      </div>
      {view === "evidence" && (
        <EvidenceList sessionId={id} selected={selectedArtifact} />
      )}
      <div hidden={view !== "response"}>
        {deployment.data &&
          deployment.data.runtime_generation !== s.generation && (
            <p className="info-note warn">
              После этой сессии ловушка была перезапущена. Новое ограничение
              применяется к текущему запуску.
            </p>
          )}
        <SourceBlocks
          adapter={
            s.protocol === "ssh"
              ? "cowrie"
              : s.protocol === "tcp"
                ? "tcp-banner"
                : "http"
          }
          deploymentId={s.deployment_id}
          sourceIp={s.source_ip}
          deploymentName={s.deployment_name}
          endpoint={deployment.data?.endpoint}
        />
      </div>
      <div hidden={view !== "context"} className="investigation-context">
        <section>
          <h2>Сохранить расследование</h2>
          <p>
            Объедините наблюдения в дело и оставьте заметку для дальнейшей
            работы.
          </p>
          <CreateCase
            sessions={[s]}
            initialIds={[s.id]}
            title={`Наблюдение ${s.source_ip}`}
          />
          <Link className="text-link" to="/cases">
            Все расследования
          </Link>
        </section>
        <section>
          <h2>Точная конфигурация</h2>
          <KeyValue label="Версия">v{s.profile_version.number}</KeyValue>
          <KeyValue label="Config hash">
            <code className="break-all">{s.profile_version.config_hash}</code>
          </KeyValue>
          <details>
            <summary>Применённая конфигурация</summary>
            <Code value={s.profile_version.config} />
          </details>
          <details>
            <summary>Происхождение сессии</summary>
            <KeyValue label="Сессия">
              <code>{s.id}</code>
            </KeyValue>
            <KeyValue label="Источник">
              <code>{s.source_id}</code>
            </KeyValue>
            <KeyValue label="Поколение запуска">
              <code>{s.generation}</code>
            </KeyValue>
            <KeyValue label="История загружена">
              <span>
                {history.data?.items.length ?? 0} из{" "}
                {history.data?.total ?? s.event_count}
              </span>
            </KeyValue>
            <KeyValue label="Курсор">
              <code>{history.data?.cursor ?? "Загружается"}</code>
            </KeyValue>
          </details>
          <GeoSources sourceIp={s.source_ip} />
        </section>
      </div>
    </div>
  );
}
