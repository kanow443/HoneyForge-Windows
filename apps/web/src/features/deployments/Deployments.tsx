import { SourceBlocks } from "../sessions/SourceBlocks";
import { bundleTotals } from "../profiles/bundle";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useRef, useState, useEffect } from "react";
import type { FormEvent } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  ArrowRight,
  Box,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Plus,
  RefreshCw,
  Search,
  Square,
} from "lucide-react";
import { adapterLabel, adapterPorts, levelLabel } from "../profiles/config";
import { api } from "../../shared/api/client";
import { PermissionNote, usePermissions } from "../auth/permissions";
import type { Job } from "../../shared/api/models";
import {
  Code,
  Empty,
  ErrorNotice,
  Field,
  KeyValue,
  Loading,
  Modal,
  PageHeader,
  Panel,
  Status,
  time,
} from "../../shared/ui";
const EvidenceList = lazy(() =>
  import("../evidence/EvidenceList").then((module) => ({
    default: module.EvidenceList,
  })),
);
const GroupRegister = lazy(() =>
  import("./Groups").then((m) => ({ default: m.GroupRegister })),
);
export function TrapsPage() {
  const { can } = usePermissions();
  const q = useQuery({
      queryKey: ["deployments"],
      queryFn: api.deployments,
      refetchInterval: 15000,
    }),
    [params, setParams] = useSearchParams();
  const search = params.get("q") ?? "",
    state = params.get("state") ?? "";
  const rows = q.data?.filter(
    (d) =>
      (!state || d.state === state) &&
      `${d.name} ${d.endpoint} ${d.profile_name}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  function filter(k: string, v: string) {
    const p = new URLSearchParams(params);
    v ? p.set(k, v) : p.delete(k);
    setParams(p, { replace: true });
  }
  return (
    <>
      <PageHeader
        eyebrow="RUNTIME"
        title="Развёртывания"
        description="Применённые профили, фактическое состояние и история выполнения."
        action={
          can("operate") && (
            <Link className="button primary" to="/traps/new">
              <Plus size={17} />
              Развернуть ловушку
            </Link>
          )
        }
      />
      <PermissionNote permission="operate" />
      <Suspense fallback={<Loading />}>
        <GroupRegister />
      </Suspense>
      <div className="fleet-readout">
        <span>
          <b>{q.data?.length ?? 0}</b> всего
        </span>
        <span className="good">
          <b>{q.data?.filter((d) => d.state === "running").length ?? 0}</b>{" "}
          работают
        </span>
        <span>
          <b>
            {q.data?.filter((d) =>
              ["requested", "applying", "stopping"].includes(d.state),
            ).length ?? 0}
          </b>{" "}
          в процессе
        </span>
        <span
          className={
            q.data?.some((d) => ["error", "unknown"].includes(d.state))
              ? "bad"
              : "muted"
          }
        >
          <b>
            {q.data?.filter((d) => ["error", "unknown"].includes(d.state))
              .length ?? 0}
          </b>{" "}
          требуют внимания
        </span>
      </div>
      <div className="toolbar">
        <div className="search-field">
          <Search size={16} />
          <input
            aria-label="Поиск ловушек"
            placeholder="Название, endpoint или профиль…"
            value={search}
            onChange={(e) => filter("q", e.target.value)}
          />
        </div>
        <select
          aria-label="Состояние ловушки"
          value={state}
          onChange={(e) => filter("state", e.target.value)}
        >
          <option value="">Все состояния</option>
          {[
            "running",
            "requested",
            "applying",
            "error",
            "unknown",
            "stopping",
            "stopped",
          ].map((s) => (
            <option value={s} key={s}>
              {
                {
                  running: "Работает",
                  requested: "В очереди",
                  applying: "Применяется",
                  error: "Ошибка",
                  unknown: "Неизвестно",
                  stopping: "Останавливается",
                  stopped: "Остановлена",
                }[s]
              }
            </option>
          ))}
        </select>
        <span className="muted">{rows?.length ?? 0} ловушек</span>
      </div>
      <ErrorNotice error={q.error} onRetry={() => q.refetch()} />
      <Panel motionKey={`${q.isPending}:${state}:${search}`}>
        {q.isPending ? (
          <Loading />
        ) : rows?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ловушка</th>
                  <th>Протокол</th>
                  <th>Состояние</th>
                  <th>Адрес</th>
                  <th>Версия</th>
                  <th>События</th>
                  <th>Наблюдалось</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <Link className="entity-link" to={`/traps/${d.id}`}>
                        <Box size={17} />
                        {d.name}
                        <small>{d.profile_name}</small>
                      </Link>
                    </td>
                    <td>
                      {adapterLabel(d.adapter)}
                      <small className="cell-sub">
                        {d.interaction_level === "low" ? "Низкий" : "Средний"}
                      </small>
                    </td>
                    <td>
                      <Status value={d.state} />
                    </td>
                    <td>
                      <code>{d.endpoint}</code>
                      <small className="cell-sub">{d.host_name}</small>
                    </td>
                    <td>
                      <span className="chip mono">v{d.version_number}</span>
                    </td>
                    <td className="mono">{d.event_count}</td>
                    <td className="mono muted">{time(d.observed_at)}</td>
                    <td>
                      <Link
                        className="icon-button"
                        aria-label={`Открыть ${d.name}`}
                        to={`/traps/${d.id}`}
                      >
                        <ChevronRight size={16} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          !q.error && (
            <Empty
              title={
                q.data?.length ? "Нет совпадений" : "Ловушки ещё не развёрнуты"
              }
              description={
                q.data?.length
                  ? "Измените запрос или состояние в фильтре."
                  : "Выберите опубликованный профиль, доступный хост и свободный порт. Состояние «Работает» появится только после подтверждения агента."
              }
              action={
                can("operate") && (
                  <Link className="button primary" to="/traps/new">
                    Развернуть ловушку <ArrowRight size={15} />
                  </Link>
                )
              }
            />
          )
        )}
      </Panel>
    </>
  );
}
export function DeploymentForm() {
  const [params] = useSearchParams(),
    nav = useNavigate(),
    client = useQueryClient();
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: api.profiles }),
    hosts = useQuery({ queryKey: ["hosts"], queryFn: api.hosts });
  const [profileId, setProfile] = useState(params.get("profile") ?? ""),
    [versionId, setVersion] = useState(params.get("version") ?? ""),
    [hostId, setHost] = useState(""),
    [name, setName] = useState(""),
    [port, setPort] = useState(8080);
  const identity = useRef<{ body: string; key: string } | null>(null);
  const profile = profiles.data?.find((p) => p.id === profileId),
    version =
      profile?.versions.find((v) => v.id === versionId) ?? profile?.versions[0];
  useEffect(() => {
    if (version && version.config.adapter !== "bundle")
      setPort(
        version.config.schema_version === 2
          ? version.config.recommended_port
          : adapterPorts[version.config.adapter],
      );
  }, [version?.id]);
  const compatible =
    hosts.data?.filter(
      (h) =>
        ["online", "degraded"].includes(h.status) &&
        h.capabilities.includes(profile?.adapter ?? ""),
    ) ?? [];
  const mutation = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        host_id: hostId,
        profile_version_id: version!.id,
        port,
      };
      const encoded = JSON.stringify(body);
      if (identity.current?.body !== encoded)
        identity.current = { body: encoded, key: crypto.randomUUID() };
      return api.deploy(body, identity.current!.key);
    },
    onSuccess: (d) => {
      void client.invalidateQueries({ queryKey: ["deployments"] });
      nav(`/traps/${d.id}`);
    },
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    if (
      !profile ||
      profile.archived_at ||
      !version ||
      !compatible.some((h) => h.id === hostId)
    )
      return;
    mutation.mutate();
  }
  return (
    <>
      <Link className="back-link" to="/traps">
        ← Ловушки
      </Link>
      <PageHeader
        eyebrow="НОВОЕ РАЗВЁРТЫВАНИЕ"
        title="Развёртывание ловушки"
        description="Зафиксируйте версию, выберите хост и порт. Агент подтвердит фактический запуск."
      />
      <p className="permission-note">
        Для профиля с несколькими сервисами{" "}
        <Link to="/groups/new">разверните группу</Link>.
      </p>
      <ErrorNotice
        error={profiles.error || hosts.error}
        onRetry={() => {
          void profiles.refetch();
          void hosts.refetch();
        }}
      />
      {profiles.isPending || hosts.isPending ? (
        <Loading />
      ) : (
        <form className="builder-grid" onSubmit={submit}>
          <Panel title="Параметры развёртывания">
            <div className="form-body">
              {!profiles.data?.length ? (
                <Empty
                  title="Сначала создайте профиль"
                  description="Для развёртывания нужна опубликованная версия конфигурации."
                  action={
                    <Link className="button primary" to="/profiles/new">
                      Создать профиль
                    </Link>
                  }
                />
              ) : (
                <>
                  {profile?.archived_at && (
                    <p className="permission-note">
                      Выбранный профиль в архиве. Восстановите его перед
                      развёртыванием.
                    </p>
                  )}
                  <Field label="Название ловушки">
                    <input
                      required
                      maxLength={100}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Например, files-stage-http"
                    />
                  </Field>
                  <div className="form-columns">
                    <Field label="Профиль">
                      <select
                        required
                        value={profileId}
                        onChange={(e) => {
                          setProfile(e.target.value);
                          setVersion("");
                          setHost("");
                          mutation.reset();
                        }}
                      >
                        <option value="">Выберите профиль</option>
                        {profiles.data
                          ?.filter(
                            (p) => !p.archived_at && p.adapter !== "bundle",
                          )
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}, {adapterLabel(p.adapter)}
                            </option>
                          ))}
                      </select>
                    </Field>
                    <Field label="Точная версия">
                      <select
                        disabled={!profile}
                        value={version?.id ?? ""}
                        onChange={(e) => setVersion(e.target.value)}
                      >
                        {profile?.versions.map((v) => (
                          <option key={v.id} value={v.id}>
                            v{v.number}, {time(v.created_at)}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <Field
                    label="Sensor host"
                    hint="На связи и с поддержкой выбранного адаптера"
                  >
                    <select
                      required
                      disabled={!profile}
                      value={hostId}
                      onChange={(e) => {
                        setHost(e.target.value);
                        mutation.reset();
                      }}
                    >
                      <option value="">Выберите совместимый хост</option>
                      {compatible.map((h) => (
                        <option key={h.id} value={h.id}>
                          {h.name}, {h.address}
                          {h.status === "degraded" ? ", с ограничениями" : ""}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {profile && !compatible.length && (
                    <div className="info-note">
                      Нет доступного хоста с адаптером{" "}
                      {adapterLabel(profile.adapter)}.{" "}
                      <Link className="text-link" to="/hosts">
                        Подключить хост
                      </Link>
                    </div>
                  )}
                  <Field
                    label="Порт"
                    hint="1024–65535. Агент проверит фактическую доступность порта."
                  >
                    <input
                      type="number"
                      min={1024}
                      max={65535}
                      required
                      value={port}
                      onChange={(e) => {
                        setPort(Number(e.target.value));
                        mutation.reset();
                      }}
                    />
                  </Field>
                  <ErrorNotice error={mutation.error} />
                </>
              )}
            </div>
            <div className="form-footer">
              <Link className="button" to="/traps">
                Отмена
              </Link>
              <button
                className="button primary"
                disabled={
                  mutation.isPending ||
                  !version ||
                  Boolean(profile?.archived_at) ||
                  !compatible.some((h) => h.id === hostId) ||
                  !name.trim()
                }
              >
                {mutation.isPending ? "Отправляем…" : "Развернуть ловушку"}
                <ArrowRight size={16} />
              </button>
            </div>
          </Panel>
          <aside className="builder-preview">
            <Panel
              title="Что будет применено"
              motionKey={`${profileId}:${versionId}:${hostId}`}
            >
              <div className="form-body">
                <KeyValue label="Профиль">
                  {profile?.name ?? "Не выбран"}{" "}
                  {version && `/ v${version.number}`}
                </KeyValue>
                <KeyValue label="Протокол">
                  {profile
                    ? `${adapterLabel(profile.adapter)} · ${levelLabel(profile.adapter)}`
                    : "—"}
                </KeyValue>
                <KeyValue label="Хост">
                  {compatible.find((h) => h.id === hostId)?.name ?? "Не выбран"}
                </KeyValue>
                <KeyValue label="Endpoint">
                  <code>
                    {compatible.find((h) => h.id === hostId)?.address ??
                      "<host>"}
                    :{port}
                  </code>
                </KeyValue>
                {version && (
                  <>
                    <KeyValue label="Легенда">
                      {version.config.persona}
                    </KeyValue>
                    <KeyValue label="Ресурсы">
                      {bundleTotals(version.config).memory} MB,{" "}
                      {bundleTotals(version.config).cpu.toFixed(1)} CPU
                    </KeyValue>
                  </>
                )}
                <div className="info-note">
                  Запрос создаст задание. Не закрывайте страницу при ошибке
                  сети: повторная отправка того же запроса сохранит ключ
                  идемпотентности.
                </div>
              </div>
            </Panel>
          </aside>
        </form>
      )}
    </>
  );
}
const stageLabels: Record<string, string> = {
  validating: "Проверка конфигурации",
  pulling: "Получение образа",
  creating: "Создание контейнера",
  starting: "Запуск сервиса",
  readiness: "Проверка готовности",
  running: "Сервис готов",
  stopping: "Остановка сервиса",
  stopped: "Сервис остановлен",
};
export function TrapDetail() {
  const { can } = usePermissions();
  const { id } = useParams(),
    [detailParams] = useSearchParams(),
    client = useQueryClient(),
    [stop, setStop] = useState(false),
    [version, setVersion] = useState("");
  const q = useQuery({
      queryKey: ["deployment", id],
      queryFn: () => api.deployment(id!),
      refetchInterval: 5000,
    }),
    profiles = useQuery({ queryKey: ["profiles"], queryFn: api.profiles });
  const sessions = useQuery({
    queryKey: ["sessions", id],
    queryFn: () => api.sessions(id),
  });
  const command = useMutation({
    mutationFn: (kind: "stop" | "redeploy") =>
      kind === "stop" ? api.stop(id!) : api.redeploy(id!, version || undefined),
    onSuccess: (d) => {
      client.setQueryData(["deployment", id], d);
      void client.invalidateQueries({ queryKey: ["deployments"] });
      setStop(false);
    },
  });
  if (q.isPending) return <Loading />;
  if (q.error)
    return <ErrorNotice error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data,
    p = profiles.data?.find((p) =>
      p.versions.some((v) => v.id === d.profile_version_id),
    ),
    config = p?.versions.find((v) => v.id === d.profile_version_id)?.config;
  return (
    <>
      <Link className="back-link" to="/traps">
        ← Ловушки
      </Link>
      <PageHeader
        eyebrow="РАЗВЁРТЫВАНИЕ"
        title={d.name}
        description={`${adapterLabel(d.adapter)} · ${levelLabel(d.adapter)}`}
        action={
          <>
            <Status value={d.state} />
            <button
              className="button"
              disabled={
                !can("operate") ||
                command.isPending ||
                ["stopping", "stopped"].includes(d.state)
              }
              onClick={() => {
                command.reset();
                setStop(true);
              }}
            >
              <Square size={14} />
              Остановить
            </button>
          </>
        }
      />
      <ErrorNotice error={command.error} />
      {d.group_id && (
        <p className="info-note">
          Сервис входит в{" "}
          <Link to={`/groups/${d.group_id}`}>многосервисную группу</Link>.
          Повторное развёртывание выполняется для всей группы; отдельная
          остановка доступна как аварийное действие.
        </p>
      )}
      {d.error && (
        <div className="error-notice">
          <strong>Ошибка runtime</strong>
          <Code value={d.error} />
        </div>
      )}
      {d.state === "unknown" && (
        <div className="info-note">
          Агент не подтверждает текущее состояние. «Неизвестно» не означает, что
          ловушка остановлена.
        </div>
      )}
      <div className="resource-strip">
        <span>
          <Box size={17} />
          <code>{d.endpoint}</code>
        </span>
        <Link to={`/profiles/${p?.id ?? ""}?version=${d.profile_version_id}`}>
          {d.profile_name}{" "}
          <span className="chip mono">v{d.version_number}</span>
        </Link>
        <Link to={`/hosts?host=${d.host_id}`}>{d.host_name}</Link>
        <span>{d.event_count} событий</span>
      </div>
      <div className="tabs">
        <a href="#runtime" className="active">
          Развёртывание
        </a>
        <Link to={`/events?deployment_id=${d.id}`}>
          События <span>{d.event_count}</span>
        </Link>
        <a href="#sessions">
          Сессии <span>{sessions.data?.length ?? 0}</span>
        </a>
        <a href="#evidence">Доказательства</a>
      </div>
      <div className="trap-detail-grid" id="runtime">
        <Panel
          title="Применение конфигурации"
          action={<span className="chip">Revision {d.desired_revision}</span>}
        >
          <div className="jobs">
            {(d.jobs as unknown as Job[]).map((job) => (
              <details key={job.id} open={job.id === d.jobs[0]?.id}>
                <summary>
                  <span>
                    {job.kind === "deploy" ? "Развёртывание" : "Остановка"},
                    попытка {job.attempt}
                  </span>
                  <Status value={job.status} />
                  <span className="mono muted">{time(job.created_at)}</span>
                </summary>
                <div className="job-stages">
                  {job.stages?.length ? (
                    job.stages.map((s, i) => (
                      <div key={i}>
                        <CheckCircle2 size={16} className="good" />
                        <span>{stageLabels[s.name] ?? s.name}</span>
                        <code>{time(s.at)}</code>
                      </div>
                    ))
                  ) : (
                    <div>
                      <Clock3 size={16} />
                      <span>Ожидаем этапы от агента</span>
                    </div>
                  )}
                  {job.error && <Code value={job.error} />}
                </div>
              </details>
            ))}
          </div>
          {!d.jobs.length && (
            <div className="quiet-empty">Задания пока не получены.</div>
          )}
        </Panel>
        <Panel title="Точное состояние">
          <div className="panel-padding">
            <KeyValue label="Желаемое">
              {d.desired_state === "running"
                ? "Запуск запрошен"
                : d.desired_state === "stopped"
                  ? "Остановка запрошена"
                  : d.desired_state}
            </KeyValue>
            <KeyValue label="Наблюдаемое">
              <Status value={d.observed_state} />
            </KeyValue>
            <KeyValue label="Подтверждено">
              {time(d.observed_at, true)}
            </KeyValue>
            <KeyValue label="Ресурсы">
              {config
                ? `${bundleTotals(config).memory} MB, ${bundleTotals(config).cpu.toFixed(1)} CPU`
                : "Загрузка профиля…"}
            </KeyValue>
            <KeyValue label="Image digest">
              <code className="break-all">
                {d.image_digest || "Ещё не подтверждён"}
              </code>
            </KeyValue>
            <KeyValue label="Runtime generation">
              <code className="break-all">{d.runtime_generation}</code>
            </KeyValue>
          </div>
        </Panel>
      </div>
      <div className="overview-lower">
        <Panel title="Повторное развёртывание">
          {p?.archived_at && (
            <p className="permission-note">
              Профиль в архиве. Восстановите его перед повторным развёртыванием.
              Работающий сервис сохраняется.
            </p>
          )}
          <div className="form-body">
            <p className="muted">
              Явно примените выбранную версию. Предыдущая история событий
              сохраняется.
            </p>
            <Field label="Версия профиля">
              <select
                value={version || d.profile_version_id}
                onChange={(e) => setVersion(e.target.value)}
              >
                {p?.versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.number}
                    {v.id === d.profile_version_id ? ", текущая" : ""}
                  </option>
                ))}
              </select>
            </Field>
            <button
              className="button"
              disabled={
                !can("operate") ||
                Boolean(d.group_id) ||
                command.isPending ||
                Boolean(p?.archived_at) ||
                ["applying", "requested", "stopping"].includes(d.state)
              }
              onClick={() => {
                if (!p?.archived_at) command.mutate("redeploy");
              }}
            >
              <RefreshCw size={15} />
              {command.isPending ? "Отправляем…" : "Применить повторно"}
            </button>
          </div>
        </Panel>
        <Panel title="Идентификаторы">
          <div className="panel-padding">
            <KeyValue label="Deployment ID">
              <code className="break-all">{d.id}</code>
            </KeyValue>
            <KeyValue label="Profile version ID">
              <code className="break-all">{d.profile_version_id}</code>
            </KeyValue>
            <KeyValue label="Создано">{time(d.created_at, true)}</KeyValue>
          </div>
        </Panel>
      </div>
      <SourceBlocks
        deploymentId={d.id}
        deploymentName={d.name}
        endpoint={d.endpoint}
        adapter={d.adapter}
      />
      <Suspense fallback={<Loading />}>
        <EvidenceList
          deploymentId={d.id}
          selected={detailParams.get("artifact")}
        />
      </Suspense>
      <Panel
        title="Связанные сессии"
        className="session-panel"
        motionKey={sessions.isPending}
      >
        <div id="sessions">
          <ErrorNotice error={sessions.error} />
          {sessions.isPending ? (
            <Loading />
          ) : sessions.data?.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Источник</th>
                    <th>Протокол</th>
                    <th>Начало</th>
                    <th>События</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sessions.data.map((s) => (
                    <tr key={s.id}>
                      <td className="mono">{s.source_ip}</td>
                      <td>{s.protocol.toUpperCase()}</td>
                      <td className="mono muted">{time(s.started_at)}</td>
                      <td>{s.event_count}</td>
                      <td>
                        <Link className="text-link" to={`/sessions/${s.id}`}>
                          Разобрать сессию <ArrowRight size={14} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="quiet-empty">
              Сессии появятся после подключения к ловушке.
            </div>
          )}
        </div>
      </Panel>
      <Modal
        open={stop && can("operate")}
        onClose={() => setStop(false)}
        title="Остановить ловушку?"
        description={`Агент получит задание остановить «${d.name}». Профиль, события и сессии сохранятся.`}
      >
        <div className="info-note">
          Панель покажет «Останавливается», затем фактический результат от
          агента.
        </div>
        <ErrorNotice error={command.error} />
        <div className="actions">
          <button className="button" onClick={() => setStop(false)}>
            Отмена
          </button>
          <button
            className="button danger"
            disabled={command.isPending}
            onClick={() => command.mutate("stop")}
          >
            {command.isPending ? "Отправляем…" : "Остановить ловушку"}
          </button>
        </div>
      </Modal>
    </>
  );
}
