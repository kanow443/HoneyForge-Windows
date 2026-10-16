import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  Plus,
  Trash2,
  Undo2,
  Redo2,
} from "lucide-react";
import type { BundleConfig, Config, ConfigV2 } from "../../shared/api/models";
import { api } from "../../shared/api/client";
import { ErrorNotice, Field, Loading, Modal, KeyValue } from "../../shared/ui";
import {
  defaultConfig,
  adapterLabel,
  levelLabel,
  type Adapter,
} from "./config";
import {
  defaultBundle,
  validateBundle,
  addBundleService,
  bundleTotals,
  type BundleDraft,
} from "./bundle";
import { useDraftHistory } from "./useDraftHistory";
import { ProfileSettings } from "./ProfileSettings";
import { StudioPreview } from "./StudioPreview";
import "./studio.css";
import "./bundle.css";
const StudioFiles = lazy(() =>
  import("./StudioFiles").then((m) => ({ default: m.StudioFiles })),
);
export function BundleBuilderPage() {
  const { id } = useParams(),
    nav = useNavigate(),
    client = useQueryClient();
  const existing = useQuery({
    queryKey: ["profile", id],
    queryFn: () => api.profile(id!),
    enabled: !!id,
  });
  const storageKey = "hf.bundle.draft." + (id ?? "new");
  const restored = useRef<{ draft: BundleDraft; base: number } | null>(null);
  const [initial] = useState<BundleDraft>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
      if (
        value?.draft?.config?.adapter === "bundle" &&
        value.draft.config.schema_version === 3 &&
        Array.isArray(value.draft.config.services) &&
        value.draft.config.services.length >= 2 &&
        value.draft.config.services.length <= 8 &&
        value.draft.config.services.every(
          (s: BundleConfig["services"][number]) =>
            typeof s.key === "string" &&
            s.config?.schema_version === 2 &&
            ["http", "cowrie", "tcp-banner"].includes(
              s.config.adapter,
            ),
        )
      ) {
        restored.current = value;
        return value.draft;
      }
    } catch {}
    return { name: "", description: "", config: defaultBundle() };
  });
  const h = useDraftHistory(initial),
    { draft } = h;
  const [selected, setSelected] = useState(0),
    [section, setSection] = useState("service"),
    [addAdapter, setAddAdapter] = useState<Adapter>("http"),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [review, setReview] = useState(false),
    [saveStatus, setSaveStatus] = useState(""),
    [path, setPath] = useState(""),
    [focus, setFocus] = useState(false);
  const seeded = useRef(false),
    published = useRef(false),
    latest = useRef(draft),
    base = useRef(0);
  latest.current = draft;
  useEffect(() => {
    if (!existing.data || seeded.current) return;
    const config = existing.data.versions[0].config;
    if (config.adapter !== "bundle") return;
    base.current = existing.data.latest_version;
    h.reset(
      restored.current?.base === base.current
        ? restored.current.draft
        : {
            name: existing.data.name,
            description: existing.data.description,
            config: structuredClone(config),
          },
    );
    seeded.current = true;
  }, [existing.data, h.reset]);
  useEffect(() => {
    if (id && !seeded.current) return;
    const timer = setTimeout(() => {
      try {
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({ draft, base: base.current }),
        );
        setSaveStatus("Черновик сохранён в этой вкладке");
      } catch {
        setSaveStatus("Черновик не сохранён: хранилище вкладки недоступно");
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [draft, id, storageKey]);
  useEffect(
    () => () => {
      if (published.current || (id && !seeded.current)) return;
      try {
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({ draft: latest.current, base: base.current }),
        );
      } catch {}
    },
    [storageKey, id],
  );
  const config = draft.config,
    index = Math.min(selected, config.services.length - 1),
    service = config.services[index],
    totals = bundleTotals(config);
  function change(next: BundleDraft, group = "") {
    h.update(next, group);
    setErrors({});
    mutation.reset();
  }
  function patchRoot(next: Partial<BundleConfig>, group: string) {
    change({ ...draft, config: { ...config, ...next } }, group);
  }
  function patchService(next: Partial<BundleConfig["services"][number]>) {
    patchRoot(
      {
        services: config.services.map((s, i) =>
          i === index ? { ...s, ...next } : s,
        ),
      },
      "",
    );
  }
  function patchChild(next: Partial<Config>, group = "") {
    change(
      {
        ...draft,
        config: {
          ...config,
          services: config.services.map((s, i) =>
            i === index
              ? {
                  ...s,
                  config: {
                    ...s.config,
                    ...next,
                    recommended_port: s.port,
                  } as ConfigV2,
                }
              : s,
          ),
        },
      },
      group ? `service.${index}.${group}` : "",
    );
  }
  function move(delta: number) {
    const next = index + delta;
    if (next < 0 || next >= config.services.length) return;
    const services = [...config.services];
    [services[index], services[next]] = [services[next], services[index]];
    patchRoot({ services }, "");
    setSelected(next);
  }
  const mutation = useMutation({
    mutationFn: async () => {
      const invalid = validateBundle(draft);
      if (Object.keys(invalid).length)
        throw new Error("Исправьте параметры сервисов");
      const normalized = {
        ...config,
        services: config.services.map((s) => ({
          ...s,
          config: {
            ...s.config,
            hostname: config.hostname,
            persona: config.persona,
            recommended_port: s.port,
          },
        })),
      };
      if (id) {
        await api.version(id, { config: normalized });
        return id;
      }
      return (
        await api.createProfile({
          name: draft.name.trim(),
          description: draft.description,
          config: normalized,
        })
      ).id;
    },
    onSuccess: (profile) => {
      published.current = true;
      try {
        sessionStorage.removeItem(storageKey);
      } catch {
        /* Publication succeeded even if browser storage is unavailable. */
      }
      void client.invalidateQueries({ queryKey: ["profiles"] });
      void client.invalidateQueries({ queryKey: ["profile", profile] });
      nav(`/profiles/${profile}?published=1`);
    },
  });
  function publish() {
    const invalid = validateBundle(draft);
    setErrors(invalid);
    const first = Object.keys(invalid).find((k) => k.startsWith("service."));
    if (first) {
      setSelected(Number(first.split(".")[1]));
      setSection("service");
    }
    if (!Object.keys(invalid).length) setReview(true);
  }
  if (id && existing.isPending) return <Loading />;
  if (existing.error)
    return (
      <ErrorNotice error={existing.error} onRetry={() => existing.refetch()} />
    );
  const child = {
    ...service.config,
    hostname: config.hostname,
    persona: config.persona,
    recommended_port: service.port,
  } as ConfigV2;
  const childErrors = Object.fromEntries(
    Object.entries(errors)
      .filter(([k]) => k.startsWith(`service.${index}.`))
      .map(([k, v]) => [k.slice(`service.${index}.`.length), v]),
  );
  return (
    <div className="trap-studio bundle-studio">
      <header className="studio-page-heading">
        <div className="studio-title">
          <Link
            className="studio-back"
            to={id ? `/profiles/${id}` : "/profiles"}
            aria-label="Вернуться к профилям"
          >
            <ArrowLeft size={18} />
          </Link>
          <h1>Конструктор ловушек</h1>
          <span className="studio-version">Несколько сервисов</span>
        </div>
        <div className="studio-page-actions">
          <button
            className="icon-button"
            aria-label="Отменить изменение"
            disabled={!h.canUndo}
            onClick={h.undo}
          >
            <Undo2 size={17} />
          </button>
          <button
            className="icon-button"
            aria-label="Повторить изменение"
            disabled={!h.canRedo}
            onClick={h.redo}
          >
            <Redo2 size={17} />
          </button>
          <button
            className="button primary"
            disabled={!!existing.data?.archived_at}
            onClick={publish}
          >
            Проверить и опубликовать
          </button>
        </div>
      </header>
      {!id && (
        <p className="bundle-mode">
          <Link to="/profiles/new">Один сервис</Link>
          <strong>Несколько сервисов</strong>
        </p>
      )}
      {existing.data?.archived_at && (
        <p className="permission-note">
          Профиль в архиве. Публикация недоступна.
        </p>
      )}
      <div className="bundle-layout">
        <aside className="bundle-sidebar">
          <Field label="Название профиля" error={errors.name}>
            <input
              value={draft.name}
              disabled={!!id}
              maxLength={100}
              onChange={(e) =>
                change({ ...draft, name: e.target.value }, "name")
              }
              onBlur={h.endGroup}
            />
          </Field>
          <Field label="Общее имя хоста" error={errors.hostname}>
            <input
              value={config.hostname}
              onChange={(e) =>
                patchRoot({ hostname: e.target.value }, "hostname")
              }
              onBlur={h.endGroup}
            />
          </Field>
          <Field label="Общая легенда" error={errors.persona}>
            <input
              value={config.persona}
              onChange={(e) =>
                patchRoot({ persona: e.target.value }, "persona")
              }
              onBlur={h.endGroup}
            />
          </Field>
          {!id && (
            <details>
              <summary>Описание профиля</summary>
              <textarea
                aria-label="Описание профиля"
                maxLength={500}
                value={draft.description}
                onChange={(e) =>
                  change(
                    { ...draft, description: e.target.value },
                    "description",
                  )
                }
              />
            </details>
          )}
          <nav aria-label="Сервисы профиля" className="bundle-service-list">
            {config.services.map((s, i) => (
              <button
                key={i}
                className={i === index ? "selected" : ""}
                aria-current={i === index ? "page" : undefined}
                onClick={() => {
                  setSelected(i);
                  setPath("");
                  setFocus(false);
                  h.endGroup();
                }}
              >
                <strong>{s.key || "Без ключа"}</strong>
                <span>
                  {adapterLabel(s.config.adapter)} · {s.port}
                </span>
                {Object.keys(errors).some((k) =>
                  k.startsWith(`service.${i}.`),
                ) && <small className="bad">Проверьте настройки</small>}
              </button>
            ))}
          </nav>
          <div className="bundle-add">
            <select
              aria-label="Протокол нового сервиса"
              value={addAdapter}
              onChange={(e) => setAddAdapter(e.target.value as Adapter)}
            >
              <option value="http">HTTP-портал</option>
              <option value="cowrie">SSH-среда · Medium</option>
              <option value="tcp-banner">TCP-баннер</option>
            </select>
            <button
              className="button"
              disabled={config.services.length >= 8}
              onClick={() => {
                const next = addBundleService(config, addAdapter);
                patchRoot(next, "");
                setSelected(next.services.length - 1);
              }}
            >
              <Plus size={14} />
              Добавить сервис
            </button>
          </div>
          <p className="bundle-budget">
            {config.services.length} из 8 сервисов
            <br />
            {totals.memory} MB · {totals.cpu.toFixed(1)} CPU
          </p>
          <p className="permission-note">
            Ресурсы запрашиваются отдельно для каждого контейнера. Общая легенда
            применяется ко всем сервисам.
          </p>
          {errors.services && (
            <p role="alert" className="bad">
              {errors.services}
            </p>
          )}
        </aside>
        <div
          className={`studio-workspace ${section === "files" ? "is-files" : ""} ${focus ? "focus-editor" : ""}`}
        >
          <section
            className="studio-editor"
            aria-label="Настройки выбранного сервиса"
          >
            <div className="bundle-service-heading">
              <strong>{adapterLabel(child.adapter)}</strong>
              <div className="actions">
                <button
                  className="icon-button"
                  aria-label="Переместить сервис выше"
                  disabled={index === 0}
                  onClick={() => move(-1)}
                >
                  <ArrowUp size={15} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Переместить сервис ниже"
                  disabled={index === config.services.length - 1}
                  onClick={() => move(1)}
                >
                  <ArrowDown size={15} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Удалить сервис"
                  disabled={config.services.length <= 2}
                  onClick={() => {
                    patchRoot(
                      {
                        services: config.services.filter((_, i) => i !== index),
                      },
                      "",
                    );
                    setSelected(Math.max(0, index - 1));
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
            <nav className="studio-sections" aria-label="Разделы сервиса">
              {[
                ["service", "Сервис"],
                ["files", "Файлы"],
                ["resources", "Ресурсы"],
              ].map(([key, label]) => (
                <button
                  className={section === key ? "active" : ""}
                  disabled={key === "files" && child.adapter === "tcp-banner"}
                  onClick={() => {
                    setSection(key);
                    setFocus(false);
                  }}
                  key={key}
                >
                  {label}
                </button>
              ))}
            </nav>
            <ErrorNotice error={mutation.error} />
            {section === "service" && (
              <div className="studio-legend-form">
                <div className="form-columns">
                  <Field
                    label="Ключ сервиса"
                    error={childErrors.key}
                    hint="Стабильный ключ для повторного развёртывания"
                  >
                    <input
                      value={service.key}
                      maxLength={24}
                      onChange={(e) => patchService({ key: e.target.value })}
                    />
                  </Field>
                  <Field label="Порт сервиса" error={childErrors.port}>
                    <input
                      type="number"
                      min={1024}
                      max={65535}
                      value={service.port}
                      onChange={(e) =>
                        patchService({ port: Number(e.target.value) })
                      }
                    />
                  </Field>
                </div>
                <Field label="Протокол сервиса">
                  <select
                    value={child.adapter}
                    onChange={(e) => {
                      patchService({
                        config: defaultConfig(e.target.value as Adapter),
                      });
                      setSection("service");
                    }}
                  >
                    <option value="http">HTTP-портал</option>
                    <option value="cowrie">SSH-среда · Medium</option>
                    <option value="tcp-banner">TCP-баннер</option>
                  </select>
                </Field>
                <p className="permission-note">{levelLabel(child.adapter)}</p>
                {child.adapter === "http" && (
                  <>
                    <Field label="Вид портала">
                      <select
                        value={child.template}
                        onChange={(e) =>
                          patchChild({
                            template: e.target.value as
                              "asset-console" | "file-vault",
                          })
                        }
                      >
                        <option value="asset-console">
                          Консоль управления
                        </option>
                        <option value="file-vault">Файловый архив</option>
                      </select>
                    </Field>
                    <Field
                      label="HTTP-баннер"
                      error={childErrors.server_banner}
                    >
                      <input
                        value={child.server_banner}
                        onChange={(e) =>
                          patchChild(
                            { server_banner: e.target.value },
                            "server_banner",
                          )
                        }
                      />
                    </Field>
                  </>
                )}
                {child.adapter === "cowrie" && (
                  <>
                    <Field label="SSH-баннер" error={childErrors.ssh_banner}>
                      <input
                        value={child.ssh_banner}
                        onChange={(e) =>
                          patchChild(
                            { ssh_banner: e.target.value },
                            "ssh_banner",
                          )
                        }
                      />
                    </Field>
                    <Field label="Загрузка файлов">
                      <select
                        value={child.download_mode ?? "blocked"}
                        onChange={(e) =>
                          patchChild({
                            download_mode: e.target.value as
                              "blocked" | "fixture",
                          })
                        }
                      >
                        <option value="blocked">Запрещена</option>
                        {child.adapter === "cowrie" && (
                          <option value="fixture">Лабораторный образец</option>
                        )}
                      </select>
                    </Field>
                  </>
                )}
                {child.adapter === "tcp-banner" && (
                  <>
                    <Field label="Баннер TCP" error={childErrors.banner}>
                      <input
                        value={child.banner}
                        onChange={(e) =>
                          patchChild({ banner: e.target.value }, "banner")
                        }
                      />
                    </Field>
                    <Field
                      label="Ответ на TCP-запрос"
                      error={childErrors.response}
                    >
                      <input
                        value={child.response}
                        onChange={(e) =>
                          patchChild({ response: e.target.value }, "response")
                        }
                      />
                    </Field>
                  </>
                )}
                <details
                  open={
                    Object.keys(childErrors).some((k) =>
                      k.startsWith("account"),
                    ) || undefined
                  }
                >
                  <summary>Дополнительные настройки</summary>
                  <ProfileSettings
                    config={child}
                    patch={patchChild}
                    errors={childErrors}
                    endGroup={h.endGroup}
                    showPort={false}
                  />
                </details>
              </div>
            )}
            {section === "files" && child.adapter !== "tcp-banner" && (
              <Suspense fallback={<Loading />}>
                <StudioFiles
                  key={index}
                  config={child}
                  patch={patchChild}
                  errors={childErrors}
                  endGroup={h.endGroup}
                  onSelect={setPath}
                  focusEditor={focus}
                  onToggleFocus={() => setFocus((v) => !v)}
                />
              </Suspense>
            )}
            {section === "resources" && (
              <div className="studio-legend-form">
                {[
                  ["memory_mb", "Память, MB", 64, 512],
                  ["cpu", "CPU", 0.1, 2],
                  ["pids", "Лимит процессов", 32, 256],
                ].map(([key, label, min, max]) => (
                  <Field
                    key={String(key)}
                    label={String(label)}
                    error={childErrors[String(key)]}
                  >
                    <input
                      type="number"
                      min={Number(min)}
                      max={Number(max)}
                      step={key === "cpu" ? 0.1 : 1}
                      value={
                        child.limits?.[key as "memory_mb" | "cpu" | "pids"]
                      }
                      onChange={(e) =>
                        patchChild(
                          {
                            limits: {
                              ...(child.limits ?? {
                                memory_mb: 128,
                                cpu: 0.5,
                                pids: 64,
                              }),
                              [key]: Number(e.target.value),
                            },
                          },
                          String(key),
                        )
                      }
                    />
                  </Field>
                ))}
              </div>
            )}
          </section>
          <StudioPreview key={index} config={child} selectedPath={path} />
        </div>
      </div>
      <p className="studio-save-status">{saveStatus}</p>
      <Modal
        open={review}
        onClose={() => !mutation.isPending && setReview(false)}
        title="Опубликовать многосервисный профиль"
        description="Проверьте состав и порты перед сохранением новой версии."
      >
        <p>
          Публикация сохраняет неизменяемую версию. Для запуска всех сервисов
          создайте группу на выбранном хосте.
        </p>
        <KeyValue label="Имя хоста">{config.hostname}</KeyValue>
        <KeyValue label="Суммарные ресурсы">
          {totals.memory} MB · {totals.cpu.toFixed(1)} CPU
        </KeyValue>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Ключ</th>
                <th>Сервис</th>
                <th>Порт</th>
              </tr>
            </thead>
            <tbody>
              {config.services.map((s, i) => (
                <tr key={i}>
                  <td>{s.key}</td>
                  <td>{adapterLabel(s.config.adapter)}</td>
                  <td>{s.port}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="permission-note">
          Повторное развёртывание группы сохраняет её ключи, протоколы и порты.
          Изменённый состав требует новой группы.
        </p>
        <ErrorNotice error={mutation.error} />
        <div className="actions">
          <button
            className="button"
            disabled={mutation.isPending}
            onClick={() => setReview(false)}
          >
            Назад к редактированию
          </button>
          <button
            className="button primary"
            disabled={mutation.isPending || !!existing.data?.archived_at}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? "Публикуем…" : "Опубликовать профиль"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
