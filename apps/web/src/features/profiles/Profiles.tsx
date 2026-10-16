import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  useParams,
  useSearchParams,
  useNavigate,
} from "react-router-dom";
import {
  ArrowRight,
  FileCode2,
  Globe,
  Layers3,
  Plus,
  Terminal,
} from "lucide-react";
import { api } from "../../shared/api/client";
import { PermissionNote, usePermissions } from "../auth/permissions";
import {
  Code,
  Field,
  Modal,
  Empty,
  ErrorNotice,
  KeyValue,
  Loading,
  PageHeader,
  Panel,
  time,
} from "../../shared/ui";
import { adapterLabel, levelLabel } from "./config";
import { Honeytokens } from "./Honeytokens";
import { bundleTotals } from "./bundle";
import type { Profile } from "../../shared/api/models";
export function ProfilesPage() {
  const { can } = usePermissions();
  const [state, setState] = useState("active");
  const q = useQuery({ queryKey: ["profiles"], queryFn: api.profiles });
  const filtered = q.data?.filter(
    (p) =>
      state === "all" ||
      (state === "archived" ? Boolean(p.archived_at) : !p.archived_at),
  );
  return (
    <>
      <PageHeader
        eyebrow="КОНФИГУРАЦИЯ"
        title="Профили ловушек"
        description="Профили Low TCP и Medium HTTP/SSH. Каждая публикация сохраняет точную конфигурацию."
        action={
          can("operate") && (
            <Link className="button primary" to="/profiles/new">
              <Plus size={17} />
              Создать профиль
            </Link>
          )
        }
      />
      <PermissionNote permission="operate" />
      <Panel
        title="Реестр профилей"
        motionKey={q.isPending}
        action={
          <select
            aria-label="Состояние профиля"
            value={state}
            onChange={(e) => setState(e.target.value)}
          >
            <option value="active">Активные</option>
            <option value="archived">В архиве</option>
            <option value="all">Все профили</option>
          </select>
        }
      >
        <ErrorNotice error={q.error} onRetry={() => q.refetch()} />
        {q.isPending ? (
          <Loading />
        ) : filtered?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Профиль</th>
                  <th>Протокол</th>
                  <th>Уровень</th>
                  <th>Версия</th>
                  <th>Создан</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link className="entity-link" to={`/profiles/${p.id}`}>
                        <FileCode2 size={17} />
                        {p.name}
                        <small>
                          {p.description || p.versions[0]?.config.persona}
                        </small>
                      </Link>
                    </td>
                    <td>{adapterLabel(p.adapter)}</td>
                    <td>{levelLabel(p.adapter)}</td>
                    <td>
                      <span className="chip mono">v{p.latest_version}</span>
                      {p.archived_at && (
                        <small className="cell-sub">В архиве</small>
                      )}
                    </td>
                    <td className="muted mono">{time(p.created_at)}</td>
                    <td>
                      {can("operate") && !p.archived_at && (
                        <Link
                          className="button small"
                          to={`/traps/new?profile=${p.id}`}
                        >
                          Развернуть <ArrowRight size={13} />
                        </Link>
                      )}
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
                state === "archived" ? "Архив пуст" : "Нет активных профилей"
              }
              description={
                state === "archived"
                  ? "Архив сохраняет версии профиля и работающие ловушки."
                  : "Создайте профиль или выберите архив. Ловушки применяют конкретную опубликованную версию."
              }
            />
          )
        )}
      </Panel>{" "}
      {can("operate") && (
        <div className="profile-start-options">
          <Link className="template-card" to="/profiles/new?adapter=http">
            <span className="template-icon">
              <Globe size={26} />
            </span>
            <div>
              <span className="eyebrow">HTTP-портал</span>
              <h2>Служебный портал</h2>
              <p>
                Правдоподобная консоль активов или файловое хранилище. Запросы и
                попытки входа.
              </p>
            </div>
            <ArrowRight size={20} />
          </Link>
          <Link className="template-card" to="/profiles/new?adapter=cowrie">
            <span className="template-icon">
              <Terminal size={26} />
            </span>
            <div>
              <span className="eyebrow">SSH (Cowrie)</span>
              <h2>Эмулируемая SSH-среда</h2>
              <p>
                Баннер OpenSSH, фиктивная файловая структура и
                последовательность команд.
              </p>
            </div>
            <ArrowRight size={20} />
          </Link>
          <Link className="template-card" to="/profiles/new?adapter=tcp-banner">
            <span className="template-icon">
              <Terminal size={26} />
            </span>
            <div>
              <span className="eyebrow">Low · TCP</span>
              <h2>TCP-баннер</h2>
              <p>Открытый порт, баннер и простой ответ. Без входа и команд.</p>
            </div>
            <ArrowRight size={20} />
          </Link>
        </div>
      )}
    </>
  );
}
export function ProfileDetail() {
  const { can } = usePermissions();
  const { id } = useParams(),
    [params, setParams] = useSearchParams();
  const q = useQuery({
    queryKey: ["profile", id],
    queryFn: () => api.profile(id!),
  });
  if (q.isPending) return <Loading />;
  if (q.error)
    return <ErrorNotice error={q.error} onRetry={() => q.refetch()} />;
  const p = q.data,
    version =
      p.versions.find((v) => v.id === params.get("version")) ?? p.versions[0];
  return (
    <>
      <Link className="back-link" to="/profiles">
        ← Профили
      </Link>
      <PageHeader
        eyebrow="ВЕРСИОНИРУЕМЫЙ ПРОФИЛЬ"
        title={p.name}
        description={
          params.has("published")
            ? `Версия ${p.latest_version} опубликована. Профиль готов к развёртыванию.`
            : p.description || "Легенда сервиса и история конфигурации."
        }
        action={
          can("operate") && (
            <>
              {!p.archived_at && (
                <>
                  <Link className="button" to={`/profiles/${p.id}/edit`}>
                    Создать новую версию
                  </Link>
                  <Link
                    className="button primary"
                    to={`${version.config.adapter === "bundle" ? "/groups/new" : "/traps/new"}?profile=${p.id}&version=${version.id}`}
                  >
                    Развернуть v{version.number}
                    <ArrowRight size={16} />
                  </Link>
                </>
              )}
            </>
          )
        }
      />
      <PermissionNote permission="operate" />
      {p.archived_at && (
        <p className="permission-note profile-archive-note">
          Профиль в архиве с {time(p.archived_at, true)}. Публикация, новые и
          повторные развёртывания недоступны. Работающие ловушки продолжают
          работу.
        </p>
      )}
      {can("operate") && <ProfileActions profile={p} />}
      <div className="resource-strip">
        <span>
          <Layers3 size={17} />
          {adapterLabel(p.adapter)}
        </span>
        <span>{levelLabel(p.adapter)}</span>
        <span>Версий: {p.versions.length}</span>
        <span className="mono">{version.config.hostname}</span>
      </div>
      <div className="profile-detail-grid">
        <Panel title="История версий">
          <div className="version-list">
            {p.versions.map((v) => (
              <button
                key={v.id}
                className={version.id === v.id ? "active" : ""}
                onClick={() => setParams({ version: v.id })}
              >
                <span className="version-marker">v{v.number}</span>
                <div>
                  <strong>
                    {v.number === p.latest_version
                      ? "Последняя версия"
                      : "Опубликованная версия"}
                  </strong>
                  <small>{time(v.created_at, true)}</small>
                </div>
              </button>
            ))}
          </div>
          <p className="panel-note">
            Новая версия не изменяет уже запущенные ловушки. Для применения
            используйте повторное развёртывание.
          </p>
        </Panel>
        <Panel title={`Конфигурация v${version.number}`} motionKey={version.id}>
          <div className="detail-grid">
            <KeyValue label="Схема профиля">
              v{version.config.schema_version}
            </KeyValue>
            {version.config.schema_version === 2 && (
              <KeyValue label="Рекомендуемый порт">
                {version.config.recommended_port}
              </KeyValue>
            )}
            <KeyValue label="Имя хоста">
              <span className="mono">{version.config.hostname}</span>
            </KeyValue>
            <KeyValue label="Легенда">{version.config.persona}</KeyValue>
            <KeyValue label="Файлы">
              {bundleTotals(version.config).files}
            </KeyValue>
            <KeyValue label="Ресурсы контейнеров">
              {bundleTotals(version.config).memory} MB,{" "}
              {bundleTotals(version.config).cpu.toFixed(1)} CPU
            </KeyValue>
          </div>
          {version.config.adapter === "bundle" && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Сервис</th>
                    <th>Протокол</th>
                    <th>Порт</th>
                    <th>Память контейнера</th>
                  </tr>
                </thead>
                <tbody>
                  {version.config.services.map((s) => (
                    <tr key={s.key}>
                      <td>{s.key}</td>
                      <td>{adapterLabel(s.config.adapter)}</td>
                      <td>{s.port}</td>
                      <td>{s.config.limits?.memory_mb ?? 128} MB</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="panel-padding">
            <details className="technical-details">
              <summary>Конфигурация JSON</summary>
              <Code value={version.config} />
              <KeyValue label="Идентификатор профиля">
                <code>{p.id}</code>
              </KeyValue>
              <KeyValue label="Хеш конфигурации">
                <code className="break-all">{version.config_hash}</code>
              </KeyValue>
            </details>
          </div>
        </Panel>
      </div>
      <Honeytokens profile={p} version={version} />
    </>
  );
}

function ProfileActions({ profile: p }: { profile: Profile }) {
  const client = useQueryClient(),
    navigate = useNavigate(),
    { can } = usePermissions();
  const [action, setAction] = useState<
      "metadata" | "archive" | "restore" | "delete" | null
    >(null),
    [name, setName] = useState(p.name),
    [description, setDescription] = useState(p.description);
  const mutation = useMutation({
    mutationFn: async () => {
      if (!can("operate")) throw new Error("Действие недоступно");
      return action === "metadata"
        ? api.profileMetadata(p.id, { name: name.trim(), description })
        : action === "delete"
          ? api.deleteProfile(p.id)
          : api.profileLifecycle(p.id, action as "archive" | "restore");
    },
    onSuccess: () => {
      const deleting = action === "delete";
      setAction(null);
      void client.invalidateQueries({ queryKey: ["profiles"] });
      void client.invalidateQueries({ queryKey: ["profile", p.id] });
      void client.invalidateQueries({ queryKey: ["audit"] });
      if (deleting) {
        client.removeQueries({ queryKey: ["profile", p.id] });
        navigate("/profiles");
      }
    },
  });
  const titles = {
    metadata: "Изменить сведения",
    archive: "Архивировать профиль",
    restore: "Восстановить профиль",
    delete: "Удалить профиль",
  };
  function open(next: NonNullable<typeof action>) {
    setName(p.name);
    setDescription(p.description);
    mutation.reset();
    setAction(next);
  }
  return (
    <div className="profile-lifecycle">
      <button className="button small" onClick={() => open("metadata")}>
        Изменить сведения
      </button>
      <button
        className="button small"
        onClick={() => open(p.archived_at ? "restore" : "archive")}
      >
        {p.archived_at ? "Восстановить" : "В архив"}
      </button>
      <details>
        <summary>Другие действия</summary>
        <button className="button small danger" onClick={() => open("delete")}>
          Удалить профиль
        </button>
      </details>
      <Modal
        open={Boolean(action)}
        onClose={() => {
          if (!mutation.isPending) setAction(null);
        }}
        title={action ? titles[action] : "Профиль"}
        description={
          action === "archive"
            ? "Архив сохраняет версии и работу существующих ловушек; новые публикации и развёртывания блокируются."
            : action === "restore"
              ? "Профиль снова станет доступен для публикации и развёртывания. Работающие ловушки не перезапускаются."
              : action === "delete"
                ? "Удаление необратимо и доступно только профилю без истории развёртываний. Для используемого профиля выберите архив."
                : "Название и описание меняются отдельно от опубликованных конфигураций."
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (can("operate") && action && !mutation.isPending)
              mutation.mutate();
          }}
        >
          {action === "metadata" ? (
            <>
              <Field label="Название профиля">
                <input
                  required
                  maxLength={100}
                  value={name}
                  disabled={mutation.isPending}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field label="Описание профиля">
                <textarea
                  maxLength={500}
                  rows={3}
                  value={description}
                  disabled={mutation.isPending}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </Field>
            </>
          ) : (
            <p className="permission-note">
              {p.name} · {p.versions.length} версий
            </p>
          )}
          <ErrorNotice error={mutation.error} />
          <div className="actions">
            <button
              className="button"
              type="button"
              disabled={mutation.isPending}
              onClick={() => setAction(null)}
            >
              Отмена
            </button>
            <button
              className={`button ${action === "delete" ? "danger" : "primary"}`}
              disabled={
                mutation.isPending || (action === "metadata" && !name.trim())
              }
            >
              {mutation.isPending
                ? "Выполняем…"
                : action
                  ? titles[action]
                  : "Подтвердить"}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
