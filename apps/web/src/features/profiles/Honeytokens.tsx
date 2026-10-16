import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { components } from "../../shared/api/generated";
import type { Profile, ProfileVersion } from "../../shared/api/models";
import {
  CopyButton,
  Empty,
  ErrorNotice,
  Field,
  KeyValue,
  Loading,
  Modal,
  time,
} from "../../shared/ui";
import { adapterLabel } from "./config";
import { usePermissions } from "../auth/permissions";
type Token = components["schemas"]["HoneyTokenView"];

export function Honeytokens({
  profile,
  version,
}: {
  profile: Profile;
  version: ProfileVersion;
}) {
  const { can } = usePermissions(),
    client = useQueryClient();
  const config = version.config;
  const services =
    config.adapter === "bundle"
      ? config.services.filter((s) =>
          ["http", "cowrie"].includes(s.config.adapter),
        )
      : [];
  const [serviceKey, setServiceKey] = useState("");
  const service = services.find((s) => s.key === serviceKey) ?? services[0];
  const adapter =
    config.adapter === "bundle" ? service?.config.adapter : config.adapter;
  const supported =
    !!adapter && ["http", "cowrie"].includes(adapter);
  const [expanded, setExpanded] = useState(false),
    [creating, setCreating] = useState(false),
    [target, setTarget] = useState<Token | null>(null),
    [name, setName] = useState(""),
    [kind, setKind] = useState<"url" | "file">(
      adapter === "http" ? "url" : "file",
    ),
    [path, setPath] = useState("/opt/decoy/access-notes.txt"),
    [confirmed, setConfirmed] = useState(false);
  const q = useQuery({
    queryKey: ["honeytokens", profile.id],
    queryFn: () => api.honeytokens(profile.id),
    enabled: expanded && supported,
    refetchInterval: expanded ? 15000 : false,
  });
  const versionRows =
    q.data?.filter((token) => token.profile_version_id === version.id) ?? [];
  const rows = versionRows.filter(
    (token) =>
      config.adapter !== "bundle" || token.service_key === service?.key,
  );
  function refresh() {
    void client.invalidateQueries({ queryKey: ["honeytokens", profile.id] });
    void client.invalidateQueries({ queryKey: ["audit"] });
  }
  const issue = useMutation({
    mutationFn: () => {
      if (
        !can("operate") ||
        !confirmed ||
        profile.archived_at ||
        !supported ||
        (kind === "url" && adapter !== "http")
      )
        throw new Error("Выпуск маркера недоступен");
      return api.createHoneytoken({
        profile_version_id: version.id,
        ...(config.adapter === "bundle" ? { service_key: service?.key } : {}),
        name: name.trim(),
        kind,
        file_path: kind === "file" ? path.trim() : null,
      });
    },
    onSuccess: () => {
      setCreating(false);
      refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: () => {
      if (!target || !can("operate"))
        throw new Error("Отзыв маркера недоступен");
      return api.revokeHoneytoken(target.id);
    },
    onSuccess: () => {
      setTarget(null);
      refresh();
    },
  });
  useEffect(() => {
    setCreating(false);
    setTarget(null);
    setConfirmed(false);
    setKind(adapter === "http" ? "url" : "file");
  }, [version.id, service?.key, adapter]);
  if (profile.adapter === "tcp-banner" || !supported) return null;
  return (
    <details
      className="technical-details profile-markers"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>Маркеры-приманки · v{version.number}</summary>
      {expanded && (
        <div className="panel-padding">
          {config.adapter === "bundle" && (
            <Field
              label="Сервис для маркеров"
              hint="Маркер применяется только к выбранному сервису этой версии. Low не поддерживает файлы и URL."
            >
              <select
                value={service?.key ?? ""}
                onChange={(event) => setServiceKey(event.target.value)}
              >
                {services.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.key} · {adapterLabel(s.config.adapter)}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <div className="section-toolbar">
            <p className="muted">
              Уникальные URL и файлы связывают наблюдение с конкретным запуском.
            </p>
            <button
              className="button small"
              disabled={
                !can("operate") ||
                Boolean(profile.archived_at) ||
                q.isPending ||
                Boolean(q.error) ||
                versionRows.filter((token) => !token.revoked_at).length >= 8
              }
              onClick={() => {
                setName("");
                setConfirmed(false);
                issue.reset();
                setCreating(true);
              }}
            >
              Создать маркер
            </button>
          </div>
          <p className="permission-note">
            Новый маркер появится после отдельного развёртывания этой версии.
            Выпуск не меняет работающую ловушку.
          </p>
          <ErrorNotice error={q.error} onRetry={() => q.refetch()} />
          {q.isPending ? (
            <Loading />
          ) : rows.length ? (
            <div className="marker-list">
              {rows.map((token) => (
                <article className="marker-row" key={token.id}>
                  <div className="section-toolbar">
                    <div>
                      <strong>{token.name}</strong>
                      <p className="muted">
                        {token.kind === "url"
                          ? "Уникальный URL"
                          : "Файл-приманка"}{" "}
                        ·{" "}
                        {token.revoked_at
                          ? "Отозван"
                          : token.bindings.length
                            ? "Выпущен"
                            : "Ожидает развёртывания"}
                      </p>
                    </div>
                    <button
                      className="button small"
                      disabled={!can("operate") || Boolean(token.revoked_at)}
                      onClick={() => {
                        revoke.reset();
                        setTarget(token);
                      }}
                    >
                      Отозвать маркер
                    </button>
                  </div>
                  {token.file_path && (
                    <code className="break-all">{token.file_path}</code>
                  )}
                  <details>
                    <summary>Применение и наблюдения</summary>
                    {!token.bindings.length && (
                      <p className="muted">
                        Для этого маркера ещё нет запуска. Разверните профиль v
                        {version.number} отдельно.
                      </p>
                    )}
                    {token.bindings.map((binding) => (
                      <div className="marker-binding" key={binding.id}>
                        <KeyValue label="ID привязки для CTF-задания">
                          <code className="break-all">{binding.id}</code>
                        </KeyValue>
                        <KeyValue label="Ловушка">
                          <code>{binding.deployment_id}</code>
                        </KeyValue>
                        <KeyValue label="Запуск">
                          {binding.current_runtime
                            ? "Текущее поколение"
                            : "Предыдущий запуск"}{" "}
                          <code>{binding.generation}</code>
                        </KeyValue>
                        <KeyValue label="Ресурс">
                          <code className="break-all">
                            {binding.resource_path}
                          </code>
                        </KeyValue>
                        <KeyValue label="Публичный маркер">
                          <code className="break-all">
                            {binding.public_value}
                          </code>
                          <CopyButton
                            value={binding.public_value}
                            label="Копировать маркер"
                          />
                        </KeyValue>
                        <KeyValue label="Наблюдения">
                          {binding.use_count}
                        </KeyValue>
                        <KeyValue label="Последнее использование">
                          {binding.last_used_at
                            ? time(binding.last_used_at, true)
                            : "Не наблюдалось"}
                        </KeyValue>
                      </div>
                    ))}
                  </details>
                  {token.revoked_at && (
                    <p className="permission-note">
                      Новые наблюдения не атрибутируются. Старые байты приманки
                      могут оставаться до повторного развёртывания; запоздалые
                      наблюдения до отзыва сохраняются.
                    </p>
                  )}
                </article>
              ))}
            </div>
          ) : (
            !q.error && (
              <Empty
                title={
                  config.adapter === "bundle"
                    ? "Маркеров выбранного сервиса пока нет"
                    : "Маркеров этой версии пока нет"
                }
                description="Выпустите URL для HTTP или отдельный файл для HTTP/SSH. Low не поддерживает маркеры."
              />
            )
          )}
          <p className="permission-note">
            До 8 активных маркеров на версию. Показаны последние 500 маркеров
            профиля и до 100 запусков каждого. Для группы лимит общий для всех
            сервисов. Маркер публичный и не является настоящим ключом доступа.
          </p>
        </div>
      )}
      <Modal
        open={creating}
        onClose={() => {
          if (!issue.isPending) setCreating(false);
        }}
        title="Создать маркер-приманку"
        description={
          "Профиль «" +
          profile.name +
          "», версия " +
          version.number +
          (service ? ", сервис «" + service.key + "»" : "") +
          ". Работающие ловушки автоматически не обновятся."
        }
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!issue.isPending && confirmed && name.trim()) issue.mutate();
          }}
        >
          <Field label="Название маркера">
            <input
              required
              maxLength={100}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="Тип маркера">
            <select
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as "url" | "file")
              }
            >
              <option value="file">Файл-приманка</option>
              {adapter === "http" && (
                <option value="url">Уникальный URL</option>
              )}
            </select>
          </Field>
          {kind === "file" && (
            <Field
              label="Путь файла-приманки"
              hint="Отдельный путь, не занятый файлом профиля."
            >
              <input
                required
                maxLength={240}
                value={path}
                onChange={(event) => setPath(event.target.value)}
                className="mono"
              />
            </Field>
          )}
          <label className="private-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            Применю маркер отдельным развёртыванием этой версии
          </label>
          <ErrorNotice error={issue.error} />
          <div className="actions">
            <button
              type="button"
              className="button"
              disabled={issue.isPending}
              onClick={() => setCreating(false)}
            >
              Отмена
            </button>
            <button
              className="button primary"
              disabled={
                issue.isPending || !can("operate") || !confirmed || !name.trim()
              }
            >
              {issue.isPending ? "Создаём…" : "Создать маркер"}
            </button>
          </div>
        </form>
      </Modal>
      <Modal
        open={Boolean(target)}
        onClose={() => {
          if (!revoke.isPending) setTarget(null);
        }}
        title="Отозвать маркер-приманку"
        description={target?.name ?? ""}
      >
        <p>
          Отзыв сразу отключит атрибуцию новых наблюдений. Файл или URL может
          оставаться в работающей ловушке до повторного развёртывания. Уже
          сохранённые доказательства не удаляются.
        </p>
        <ErrorNotice error={revoke.error} />
        <div className="actions">
          <button
            className="button"
            disabled={revoke.isPending}
            onClick={() => setTarget(null)}
          >
            Отмена
          </button>
          <button
            className="button danger"
            disabled={revoke.isPending || !can("operate")}
            onClick={() => revoke.mutate()}
          >
            {revoke.isPending ? "Отзываем…" : "Отозвать маркер"}
          </button>
        </div>
      </Modal>
    </details>
  );
}
