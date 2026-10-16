import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { api } from "../../shared/api/client";
import type { BundleConfig, DeploymentGroup } from "../../shared/api/models";
import { adapterLabel } from "../profiles/config";
import { bundleTotals, groupCompatible } from "../profiles/bundle";
import { usePermissions } from "../auth/permissions";
import {
  ErrorNotice,
  Field,
  Loading,
  Modal,
  PageHeader,
  Panel,
  Status,
  Empty,
  KeyValue,
} from "../../shared/ui";
import "../profiles/bundle.css";
const explanation: Record<DeploymentGroup["state"], string> = {
  running: "Все сервисы подтвердили запуск.",
  stopped: "Все сервисы остановлены.",
  requested: "Запрошен запуск. Ожидаем подтверждения отдельных сервисов.",
  mixed: "Сервисы находятся в разных состояниях. Проверьте каждый сервис.",
  error: "Один или несколько сервисов сообщили об ошибке.",
  unknown: "Фактическое состояние не подтверждено. Это не означает остановку.",
};
export function GroupRegister() {
  const { can } = usePermissions();
  const q = useQuery({
    queryKey: ["groups"],
    queryFn: api.groups,
    refetchInterval: 5000,
  });
  return (
    <details className="technical-details group-register">
      <summary>
        Многосервисные группы{q.data ? ` · ${q.data.length}` : ""}
      </summary>
      <div className="section-toolbar">
        <p className="muted">
          Один профиль, несколько сервисов на выбранном хосте.
        </p>
        {can("operate") && (
          <Link className="button" to="/groups/new">
            Развернуть группу
          </Link>
        )}
      </div>
      <ErrorNotice error={q.error} onRetry={() => q.refetch()} />
      {q.isPending ? (
        <Loading />
      ) : q.data?.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Группа</th>
                <th>Сервисы</th>
                <th>Состояние</th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((g) => (
                <tr key={g.id}>
                  <td>
                    <Link to={`/groups/${g.id}`}>{g.name}</Link>
                  </td>
                  <td>{g.services.length}</td>
                  <td>
                    <Status value={g.state} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !q.error && (
          <Empty
            title="Группы ещё не созданы"
            description="Опубликуйте профиль с несколькими сервисами и выберите хост для всей группы."
          />
        )
      )}
    </details>
  );
}
export function GroupDeploymentForm() {
  const [params] = useSearchParams(),
    nav = useNavigate(),
    client = useQueryClient(),
    { can } = usePermissions();
  const profiles = useQuery({ queryKey: ["profiles"], queryFn: api.profiles }),
    hosts = useQuery({ queryKey: ["hosts"], queryFn: api.hosts }),
    deployments = useQuery({
      queryKey: ["deployments"],
      queryFn: api.deployments,
      refetchInterval: 5000,
    });
  const [profileId, setProfile] = useState(params.get("profile") ?? ""),
    [versionId, setVersion] = useState(params.get("version") ?? ""),
    [hostId, setHost] = useState(""),
    [name, setName] = useState(""),
    [ports, setPorts] = useState<Record<string, number>>({}),
    [review, setReview] = useState<Body | null>(null);
  type Body = {
    name: string;
    host_id: string;
    profile_version_id: string;
    ports: Record<string, number>;
  };
  const profile = profiles.data?.find((p) => p.id === profileId),
    version =
      profile?.versions.find((v) => v.id === versionId) ?? profile?.versions[0],
    config = version?.config.adapter === "bundle" ? version.config : null;
  useEffect(() => {
    setPorts(
      Object.fromEntries(config?.services.map((s) => [s.key, s.port]) ?? []),
    );
    setHost("");
    setReview(null);
  }, [version?.id]);
  const compatible =
    hosts.data?.filter(
      (h) =>
        ["online", "degraded"].includes(h.status) &&
        config?.services.every((s) =>
          h.capabilities.includes(s.config.adapter),
        ),
    ) ?? [];
  const errors: Record<string, string> = {},
    seen = new Set<number>();
  config?.services.forEach((s) => {
    const port = ports[s.key];
    if (
      !Number.isInteger(port) ||
      port < 1024 ||
      port > 65535 ||
      seen.has(port)
    )
      errors[s.key] = "Уникальный порт от 1024 до 65535";
    seen.add(port);
    if (
      deployments.data?.some(
        (d) => d.host_id === hostId && d.port === port && d.state !== "stopped",
      )
    )
      errors[s.key] = "Порт занят или зарезервирован на этом хосте";
  });
  const identity = useRef<{ body: string; key: string } | null>(null);
  const mutation = useMutation({
    mutationFn: () => {
      if (!review || !can("operate")) throw Error("Развёртывание недоступно");
      const body = JSON.stringify(review);
      if (identity.current?.body !== body)
        identity.current = { body, key: crypto.randomUUID() };
      return api.deployGroup(review, identity.current.key);
    },
    onSuccess: (g) => {
      void client.invalidateQueries({ queryKey: ["groups"] });
      void client.invalidateQueries({ queryKey: ["deployments"] });
      nav(`/groups/${g.id}`);
    },
  });
  const valid =
    !!config &&
    !profile?.archived_at &&
    !!name.trim() &&
    name.length <= 100 &&
    compatible.some((h) => h.id === hostId) &&
    !Object.keys(errors).length &&
    !deployments.error &&
    !deployments.isPending;
  return (
    <>
      <Link className="back-link" to="/traps">
        ← Развёртывания
      </Link>
      <PageHeader
        title="Развёртывание группы"
        description="Все сервисы профиля запускаются на одном хосте. Состояние подтверждается агентом для каждого сервиса."
      />
      <ErrorNotice error={profiles.error || hosts.error || deployments.error} />
      {profiles.isPending || hosts.isPending ? (
        <Loading />
      ) : (
        <form
          className="builder-grid"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid)
              setReview({
                name: name.trim(),
                host_id: hostId,
                profile_version_id: version!.id,
                ports: { ...ports },
              });
          }}
        >
          <Panel title="Параметры группы">
            <div className="form-body">
              <Field label="Название группы">
                <input
                  required
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field label="Многосервисный профиль">
                <select
                  value={profileId}
                  onChange={(e) => {
                    setProfile(e.target.value);
                    setVersion("");
                    mutation.reset();
                  }}
                >
                  <option value="">Выберите профиль</option>
                  {profiles.data
                    ?.filter((p) => p.adapter === "bundle" && !p.archived_at)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Версия профиля">
                <select
                  value={version?.id ?? ""}
                  disabled={!profile}
                  onChange={(e) => setVersion(e.target.value)}
                >
                  {profile?.versions
                    .filter((v) => v.config.adapter === "bundle")
                    .map((v) => (
                      <option key={v.id} value={v.id}>
                        v{v.number}
                      </option>
                    ))}
                </select>
              </Field>
              <Field
                label="Хост группы"
                hint="Хост должен поддерживать все протоколы группы"
              >
                <select
                  value={hostId}
                  disabled={!config}
                  onChange={(e) => setHost(e.target.value)}
                >
                  <option value="">Выберите совместимый хост</option>
                  {compatible.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name} · {h.address}
                      {h.status === "degraded" ? " · с ограничениями" : ""}
                    </option>
                  ))}
                </select>
              </Field>
              {config && !compatible.length && (
                <p className="permission-note">
                  На связи нет хоста с поддержкой всех сервисов этой версии.
                </p>
              )}
              <div className="group-port-grid">
                {config?.services.map((s) => (
                  <Field
                    key={s.key}
                    label={`Порт ${s.key}`}
                    hint={adapterLabel(s.config.adapter)}
                    error={errors[s.key]}
                  >
                    <input
                      type="number"
                      required
                      min={1024}
                      max={65535}
                      value={ports[s.key] ?? s.port}
                      onChange={(e) =>
                        setPorts({ ...ports, [s.key]: Number(e.target.value) })
                      }
                    />
                  </Field>
                ))}
              </div>
              <button
                className="button primary"
                disabled={!valid || !can("operate") || mutation.isPending}
              >
                Проверить развёртывание
              </button>
              {!profiles.data?.some(
                (p) => p.adapter === "bundle" && !p.archived_at,
              ) && (
                <Link className="button" to="/profiles/new?adapter=bundle">
                  Создать многосервисный профиль
                </Link>
              )}
            </div>
          </Panel>
          <Panel title="Состав и ресурсы">
            {config ? (
              <div className="form-body">
                <KeyValue label="Имя хоста">{config.hostname}</KeyValue>
                <KeyValue label="Легенда">{config.persona}</KeyValue>
                <KeyValue label="Суммарные ресурсы контейнеров">
                  {bundleTotals(config).memory} MB ·{" "}
                  {bundleTotals(config).cpu.toFixed(1)} CPU
                </KeyValue>
                {config.services.map((s) => (
                  <div key={s.key} className="group-service-card">
                    <strong>{s.key}</strong>
                    <span>{adapterLabel(s.config.adapter)}</span>
                  </div>
                ))}
                <p className="permission-note">
                  Конфликт любого порта отклоняет создание целиком. Запуск
                  асинхронный: частичные ошибки остаются видимыми для каждого
                  сервиса.
                </p>
              </div>
            ) : (
              <Empty
                title="Выберите опубликованную версию"
                description="Здесь появятся точные сервисы и запрошенные ресурсы."
              />
            )}
          </Panel>
        </form>
      )}
      <Modal
        open={!!review}
        onClose={() => !mutation.isPending && setReview(null)}
        title="Развернуть все сервисы группы"
        description="Запуск будет подтверждён отдельно для каждого сервиса."
      >
        <p>{review?.name}</p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Сервис</th>
                <th>Порт</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(review?.ports ?? {}).map(([key, port]) => (
                <tr key={key}>
                  <td>{key}</td>
                  <td>{port}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="permission-note">
          Запрос создаст задания для всех сервисов. «Работает» появится только
          после их подтверждения. Повторная отправка неизменного запроса
          сохраняет ключ идемпотентности.
        </p>
        <ErrorNotice error={mutation.error} />
        <div className="actions">
          <button
            className="button"
            disabled={mutation.isPending}
            onClick={() => setReview(null)}
          >
            Назад
          </button>
          <button
            className="button primary"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? "Отправляем…" : "Развернуть группу"}
          </button>
        </div>
      </Modal>
    </>
  );
}
export function GroupDetailPage() {
  const { id } = useParams(),
    client = useQueryClient(),
    { can } = usePermissions();
  const q = useQuery({
      queryKey: ["group", id],
      queryFn: () => api.group(id!),
      refetchInterval: 3000,
    }),
    profiles = useQuery({ queryKey: ["profiles"], queryFn: api.profiles }),
    hosts = useQuery({ queryKey: ["hosts"], queryFn: api.hosts });
  const [action, setAction] = useState<"stop" | "redeploy" | null>(null),
    [versionId, setVersion] = useState("");
  const group = q.data,
    profile = profiles.data?.find((p) =>
      p.versions.some((v) => v.id === group?.profile_version_id),
    ),
    original = profile?.versions.find(
      (v) => v.id === group?.profile_version_id,
    )?.config;
  const compatible =
    original?.adapter === "bundle"
      ? (profile?.versions.filter((v) => groupCompatible(original, v.config)) ??
        [])
      : [];
  const mutation = useMutation({
    mutationFn: () => {
      if (!can("operate") || !group) throw Error("Действие недоступно");
      return action === "stop"
        ? api.stopGroup(group.id)
        : api.redeployGroup(group.id, versionId || group.profile_version_id);
    },
    onSuccess: () => {
      setAction(null);
      void client.invalidateQueries({ queryKey: ["group", id] });
      void client.invalidateQueries({ queryKey: ["groups"] });
      void client.invalidateQueries({ queryKey: ["deployments"] });
    },
  });
  if (q.isPending) return <Loading />;
  if (q.error)
    return <ErrorNotice error={q.error} onRetry={() => q.refetch()} />;
  if (!group) return null;
  return (
    <>
      <Link className="back-link" to="/traps">
        ← Развёртывания
      </Link>
      <PageHeader
        title={group.name}
        description="Многосервисная группа"
        action={
          <>
            <Status value={group.state} />
            <button
              className="button"
              disabled={
                !can("operate") ||
                group.state === "stopped" ||
                mutation.isPending
              }
              onClick={() => {
                mutation.reset();
                setAction("stop");
              }}
            >
              Остановить группу
            </button>
          </>
        }
      />
      <p className="info-note">
        {explanation[group.state] ?? "Состояние сервера не распознано."}
      </p>
      <ErrorNotice error={profiles.error || hosts.error} />
      <div className="resource-strip">
        <Link to={`/hosts?host=${group.host_id}`}>
          {hosts.data?.find((h) => h.id === group.host_id)?.name ??
            group.host_id}
        </Link>
        {profile && (
          <Link
            to={`/profiles/${profile.id}?version=${group.profile_version_id}`}
          >
            {profile.name}
          </Link>
        )}
        <span>{group.services.length} сервисов</span>
      </div>
      <Panel title="Фактическое состояние сервисов">
        {group.services.map((s) => (
          <article key={s.id} className="group-service-card">
            <div>
              <Link to={`/traps/${s.id}`}>
                <strong>{s.service_key ?? s.name}</strong>
              </Link>
              <small>
                {adapterLabel(s.adapter)} · <code>{s.endpoint}</code>
              </small>
              {s.error && (
                <p className="bad">
                  Сервис сообщил об ошибке. Подробности доступны в его карточке.
                </p>
              )}
            </div>
            <div className="actions">
              <Status value={s.state} />
              <Link
                className="button small"
                to={`/events?deployment_id=${s.id}`}
              >
                События
              </Link>
              <Link className="button small" to={`/traps/${s.id}#evidence`}>
                Доказательства
              </Link>
            </div>
          </article>
        ))}
      </Panel>
      <Panel title="Повторное развёртывание группы">
        <div className="form-body">
          <p className="muted">
            Все сервисы получают выбранную версию. Ключи, протоколы и
            опубликованные порты группы сохраняются. Для другого состава
            создайте новую группу.
          </p>
          <Field label="Совместимая версия группы">
            <select
              disabled={!compatible.length}
              value={versionId || group.profile_version_id}
              onChange={(e) => setVersion(e.target.value)}
            >
              {compatible.map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.number}
                  {v.id === group.profile_version_id ? " · текущая" : ""}
                </option>
              ))}
            </select>
          </Field>
          {profile?.archived_at && (
            <p className="permission-note">
              Профиль в архиве. Восстановите его для повторного развёртывания.
            </p>
          )}
          <button
            className="button"
            disabled={
              !can("operate") ||
              !!profile?.archived_at ||
              !compatible.length ||
              mutation.isPending
            }
            onClick={() => {
              mutation.reset();
              setAction("redeploy");
            }}
          >
            Повторно развернуть группу
          </button>
        </div>
      </Panel>
      <Modal
        open={!!action}
        onClose={() => !mutation.isPending && setAction(null)}
        description="Действие применяется ко всей группе. История и доказательства сохраняются."
        title={
          action === "stop"
            ? "Остановить все сервисы группы?"
            : "Повторно развернуть все сервисы?"
        }
      >
        <p>{group.services.map((s) => s.service_key ?? s.name).join(", ")}</p>
        <p className="permission-note">
          {action === "stop"
            ? "Агент остановит сервисы отдельно. История событий и доказательства сохраняются."
            : "Действие затрагивает все сервисы. Порты сохраняются, применение подтверждается каждым сервисом."}
        </p>
        <ErrorNotice error={mutation.error} />
        <div className="actions">
          <button
            className="button"
            disabled={mutation.isPending}
            onClick={() => setAction(null)}
          >
            Отмена
          </button>
          <button
            className="button primary"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending
              ? "Отправляем…"
              : action === "stop"
                ? "Остановить группу"
                : "Применить версию к группе"}
          </button>
        </div>
      </Modal>
    </>
  );
}
