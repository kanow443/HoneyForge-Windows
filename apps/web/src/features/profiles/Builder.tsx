import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { MotionIndicator } from "../../shared/ui/motion";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Download,
  Undo2,
  Redo2,
} from "lucide-react";
import { api, ApiError } from "../../shared/api/client";
import type { Config } from "../../shared/api/models";
import {
  Code,
  ErrorNotice,
  Field,
  KeyValue,
  Loading,
  Modal,
} from "../../shared/ui";
import {
  defaultConfig,
  validateDraft,
  upgradeConfig,
  adapterLabels,
  levelLabel,
} from "./config";
import type { ProfileDraft, Adapter } from "./config";
import { useDraftHistory } from "./useDraftHistory";
import { StudioPreview } from "./StudioPreview";
import { ProfileSettings } from "./ProfileSettings";
const StudioFiles = lazy(() =>
  import("./StudioFiles").then((module) => ({ default: module.StudioFiles })),
);
import "./studio.css";
import { BundleBuilderPage } from "./BundleBuilder";
type Section = "legend" | "files" | "limits";
type Saved = { schema: 1; draft: ProfileDraft; baseVersion: number };
function restore(key: string): Saved | undefined {
  try {
    const data = JSON.parse(
      sessionStorage.getItem(key) ?? "null",
    ) as Saved | null;
    const d = data?.draft;
    if (
      data?.schema === 1 &&
      d &&
      typeof d.name === "string" &&
      typeof d.description === "string" &&
      ["http", "cowrie", "tcp-banner"].includes(
        d.config?.adapter,
      ) &&
      typeof d.config.hostname === "string" &&
      typeof d.config.persona === "string" &&
      [1, 2].includes(d.config.schema_version) &&
      Number.isInteger(data.baseVersion) &&
      (d.config.adapter === "http"
        ? typeof d.config.server_banner === "string" &&
          ["asset-console", "file-vault"].includes(d.config.template)
        : d.config.adapter === "cowrie"
          ? typeof d.config.ssh_banner === "string"
          : typeof d.config.banner === "string" &&
            typeof d.config.response === "string") &&
      (!d.config.limits ||
        ["memory_mb", "cpu", "pids"].every((k) =>
          Number.isFinite(d.config.limits?.[k as keyof typeof d.config.limits]),
        )) &&
      (d.config.schema_version !== 2 ||
        (typeof d.config.recommended_port === "number" &&
          (!d.config.decoy_accounts ||
            (Array.isArray(d.config.decoy_accounts) &&
              d.config.decoy_accounts.every(
                (a) =>
                  a &&
                  typeof a.username === "string" &&
                  typeof a.password === "string",
              ))) &&
          (!d.config.recording ||
            (typeof d.config.recording.capture_credentials === "boolean" &&
              typeof d.config.recording.http_payload_bytes === "number" &&
              typeof d.config.recording.shell_output_bytes === "number")) &&
          (!d.config.beacon ||
            (typeof d.config.beacon.interval_seconds === "number" &&
              typeof d.config.beacon.jitter_ratio === "number")))) &&
      Array.isArray(d.config.decoy_files) &&
      d.config.decoy_files.every(
        (f) => f && typeof f.path === "string" && typeof f.content === "string",
      )
    )
      return data;
  } catch {
    /* Storage may be unavailable; the editor remains usable. */
  }
}
function draftFile(config: Config) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(config, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `${config.hostname || "honeyforge"}-profile.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const sectionData = [
  { id: "legend", title: "Сервис" },
  { id: "files", title: "Файлы" },
  { id: "limits", title: "Ресурсы" },
] as const;
function fileCount(count: number) {
  return `${count} ${count === 1 ? "файл" : count >= 2 && count <= 4 ? "файла" : "файлов"}`;
}
export function BuilderPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const profile = useQuery({
    queryKey: ["profile", id],
    queryFn: () => api.profile(id!),
    enabled: !!id,
  });
  if (id && profile.isPending) return <Loading />;
  if (
    profile.data?.versions[0].config.adapter === "bundle" ||
    (!id && params.get("adapter") === "bundle")
  )
    return <BundleBuilderPage key={id ?? "bundle-new"} />;
  return <BuilderStudio key={id ?? "new"} />;
}
function BuilderStudio() {
  const [selectedFile, setSelectedFile] = useState("");
  const [focusEditor, setFocusEditor] = useState(false);
  const { id } = useParams(),
    [params] = useSearchParams(),
    navigate = useNavigate(),
    client = useQueryClient();
  const storageKey = `honeyforge.profile-draft.${id ?? "new"}`;
  const [saved] = useState(() => {
    const restored = restore(storageKey);
    return restored && !id
      ? {
          ...restored,
          draft: {
            ...restored.draft,
            config: upgradeConfig(restored.draft.config),
          },
        }
      : restored;
  });
  const history = useDraftHistory(
    saved?.draft ?? {
      name: "",
      description: "",
      config: defaultConfig(
        params.get("adapter") === "cowrie"
            ? "cowrie"
            : params.get("adapter") === "tcp-banner"
              ? "tcp-banner"
              : "http",
      ),
    },
  );
  const { draft, update, reset, endGroup } = history,
    { name, description, config } = draft;
  const [section, setSection] = useState<Section>("legend"),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [review, setReview] = useState(false),
    [saveStatus, setSaveStatus] = useState(""),
    [recovered, setRecovered] = useState(!!saved),
    [preset, setPreset] = useState("");
  const seeded = useRef(false),
    saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const existing = useQuery({
    queryKey: ["profile", id],
    queryFn: () => api.profile(id!),
    enabled: !!id,
  });
  const latestDraft = useRef(draft),
    baseVersion = useRef(0),
    published = useRef(false);
  latestDraft.current = draft;
  baseVersion.current = existing.data?.latest_version ?? 0;
  useEffect(() => {
    function flush() {
      if (published.current || (id && !seeded.current)) return;
      try {
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({
            schema: 1,
            draft: latestDraft.current,
            baseVersion: baseVersion.current,
          }),
        );
      } catch {
        /* The editor remains usable if tab storage is unavailable. */
      }
    }
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [storageKey, id]);
  useEffect(() => {
    if (!existing.data || seeded.current) return;
    const p = existing.data;
    const source = p.versions[0].config;
    if (source.adapter === "bundle") return;
    reset({
      name: p.name,
      description: p.description,
      config:
        saved?.baseVersion === p.latest_version
          ? saved.draft.config
          : structuredClone(source),
    });
    setRecovered(!!saved && saved.baseVersion === p.latest_version);
    seeded.current = true;
  }, [existing.data, reset, saved]);
  useEffect(() => {
    if (id && !seeded.current) return;
    setSaveStatus("Сохраняем черновик…");
    saveTimer.current = setTimeout(() => {
      try {
        sessionStorage.setItem(
          storageKey,
          JSON.stringify({
            schema: 1,
            draft,
            baseVersion: existing.data?.latest_version ?? 0,
          }),
        );
        setSaveStatus("Черновик сохранён в этой вкладке");
      } catch {
        setSaveStatus("Черновик не сохранён: хранилище вкладки недоступно");
      }
    }, 400);
    return () => clearTimeout(saveTimer.current);
  }, [draft, storageKey, id, existing.data?.latest_version]);
  const mutation = useMutation({
    mutationFn: async () => {
      if (existing.data?.archived_at)
        throw new ApiError(409, "profile_archived", "Archived profile");
      if (id) {
        await api.version(id, { config });
        return id;
      }
      return (
        await api.createProfile({ name: name.trim(), description, config })
      ).id;
    },
    onSuccess: (profile) => {
      published.current = true;
      clearTimeout(saveTimer.current);
      try {
        sessionStorage.removeItem(storageKey);
      } catch {}
      void client.invalidateQueries({ queryKey: ["profiles"] });
      void client.invalidateQueries({ queryKey: ["profile", id] });
      navigate(`/profiles/${profile}?published=1`);
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        const fields: Record<string, string> = {};
        error.fields.forEach(
          (f) =>
            (fields[
              f.path.replace(
                /^body\.(?:config\.(?:http\.|cowrie\.|tcp-banner\.)?)?/,
                "",
              )
            ] = f.message),
        );
        setErrors(fields);
        setReview(false);
        setSection(
          Object.keys(fields).some(
            (k) =>
              k.startsWith("decoy_files") ||
              k.startsWith("path") ||
              k.startsWith("content"),
          )
            ? "files"
            : Object.keys(fields).some((k) => k.startsWith("limits"))
              ? "limits"
              : "legend",
        );
      }
    },
  });
  function change(next: ProfileDraft, group = "") {
    update(next, group);
    mutation.reset();
    setErrors({});
  }
  function patch(p: Partial<Config>, group = "") {
    change({ ...draft, config: { ...config, ...p } as Config }, group);
  }
  function switchAdapter(adapter: Adapter) {
    if (adapter === config.adapter || id) return;
    const previous = upgradeConfig(config);
    const next = {
      ...defaultConfig(adapter),
      hostname: config.hostname,
      persona: config.persona,
      decoy_files: config.decoy_files,
      limits: config.limits,
      decoy_accounts: previous.decoy_accounts,
      recording: previous.recording,
      beacon: previous.beacon,
    };
    change({ ...draft, config: next });
    setPreset("");
    if (adapter === "tcp-banner") {
      setSection("legend");
      setFocusEditor(false);
    }
  }
  function applyPreset(value: string) {
    setPreset("");
    if (!value) return;
    const adapter =
        value === "bastion"
          ? "cowrie"
          : value === "banner"
            ? "tcp-banner"
            : "http",
      c = defaultConfig(adapter);
    if (value === "vault") {
      c.persona = "Backup Services";
      c.hostname = "vault-internal-02";
      if (c.adapter === "http") c.template = "file-vault";
      c.decoy_files = [
        {
          path: "/opt/decoy/backup-notes.txt",
          content:
            "STAGING BACKUP INVENTORY\nEnvironment: staging\nArchive: staging-backup-2026.tar.gz\nRetention: 14 days\nContact: infrastructure team\n\nSynthetic training data.",
        },
        {
          path: "/opt/decoy/archive-manifest.csv",
          content:
            "archive,environment,status\nstaging-backup-2026.tar.gz,staging,complete\nassets-snapshot.tar.gz,staging,retained",
        },
      ];
    }
    if (value === "assets") {
      c.persona = "Infrastructure Operations";
      c.hostname = "assets-stage-01";
      c.decoy_files = [
        {
          path: "/opt/decoy/inventory.csv",
          content:
            "hostname,role,environment\nassets-stage-01,asset-console,staging\nvault-internal-02,backup-vault,staging",
        },
        {
          path: "/var/www/maintenance.txt",
          content:
            "Internal maintenance schedule\nStaging environment only\nNext review: Friday 18:00 UTC\nSynthetic training data.",
        },
      ];
    }
    if (value === "bastion") {
      c.persona = "Development Operations";
      c.hostname = "build-dev-03";
      c.decoy_files = [
        {
          path: "/home/admin/deploy-notes.txt",
          content:
            "Development deployment notes\nService: asset-worker\nBranch: staging\nRelease window: Friday 18:00 UTC\nSynthetic training data.",
        },
        {
          path: "/opt/decoy/backup-notes.txt",
          content:
            "Staging backup inventory\nLatest archive: build-dev-03-staging.tar.gz\nSynthetic training data.",
        },
      ];
    }
    if (id && adapter !== config.adapter) return;
    change({
      ...draft,
      name:
        name ||
        ({
          vault: "Архив резервных копий",
          assets: "Консоль инфраструктуры",
          bastion: "Сервер разработки",
          banner: "TCP-служба",
        }[value] ??
          ""),
      config: c,
    });
  }
  const issues = validateDraft(draft),
    limits = config.limits ?? { memory_mb: 128, cpu: 0.5, pids: 64 };
  const sectionIssues = {
    legend: Object.keys(issues).filter(
      (k) =>
        !["memory_mb", "cpu", "pids"].includes(k) &&
        !k.startsWith("path") &&
        !k.startsWith("content") &&
        k !== "files" /* service fields include v2 settings */,
    ),
    files: Object.keys(issues).filter(
      (k) => k.startsWith("path") || k.startsWith("content") || k === "files",
    ),
    limits: Object.keys(issues).filter((k) =>
      ["memory_mb", "cpu", "pids"].includes(k),
    ),
  };
  const ready = Object.keys(issues).length === 0;
  const [advanced, setAdvanced] = useState(false);
  function checkField(field: string) {
    const message = validateDraft(draft)[field];
    setErrors((e) => {
      const n = { ...e };
      message ? (n[field] = message) : delete n[field];
      return n;
    });
    endGroup();
  }
  function openReview() {
    if (existing.data?.archived_at) return;
    setErrors(issues);
    if (
      sectionIssues.legend.some(
        (k) => !["name", "hostname", "persona"].includes(k),
      )
    )
      setAdvanced(true);
    if (!ready) {
      setSection(
        sectionIssues.legend.length
          ? "legend"
          : sectionIssues.files.length
            ? "files"
            : "limits",
      );
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLInputElement>(".studio-editor input")
          ?.focus(),
      );
      return;
    }
    endGroup();
    setReview(true);
  }
  if (id && existing.isPending) return <Loading />;
  if (existing.error)
    return (
      <ErrorNotice error={existing.error} onRetry={() => existing.refetch()} />
    );
  return (
    <div className="trap-studio">
      <header className="studio-page-heading">
        <div className="studio-title">
          <Link
            className="studio-back"
            aria-label="Вернуться к профилям"
            to={id ? `/profiles/${id}` : "/profiles"}
          >
            <ArrowLeft size={18} />
          </Link>
          <h1>Конструктор ловушек</h1>
          {id && (
            <span className="studio-version">
              Версия {(existing.data?.latest_version ?? 0) + 1}
            </span>
          )}
        </div>
        <div className="studio-page-actions">
          {!id && (
            <Link className="button" to="/profiles/new?adapter=bundle">
              Несколько сервисов
            </Link>
          )}
          <div className="studio-history">
            <button
              type="button"
              className="icon-button"
              disabled={!history.canUndo}
              aria-label="Отменить изменение"
              title="Отменить изменение"
              onClick={() => {
                history.undo();
                setErrors({});
                mutation.reset();
              }}
            >
              <Undo2 size={17} />
            </button>
            <button
              type="button"
              className="icon-button"
              disabled={!history.canRedo}
              aria-label="Повторить изменение"
              title="Повторить изменение"
              onClick={() => {
                history.redo();
                setErrors({});
                mutation.reset();
              }}
            >
              <Redo2 size={17} />
            </button>
          </div>
          <button
            type="button"
            className="button primary"
            aria-label="Проверить и опубликовать"
            disabled={Boolean(existing.data?.archived_at)}
            onClick={openReview}
          >
            Опубликовать
            <ArrowRight size={15} />
          </button>
        </div>
      </header>
      {existing.data?.archived_at && (
        <p className="permission-note">
          Профиль в архиве. Восстановите его на странице профиля перед
          публикацией. Работающие ловушки сохраняются.
        </p>
      )}
      <div
        className={`studio-workspace ${section === "files" ? "is-files" : ""} ${focusEditor ? "focus-editor" : ""}`}
      >
        <section className="studio-editor" aria-label="Настройки ловушки">
          <nav className="studio-sections" aria-label="Разделы конструктора">
            <MotionIndicator active={section} />
            {sectionData.map((s) => (
              <button
                type="button"
                key={s.id}
                disabled={s.id === "files" && config.adapter === "tcp-banner"}
                title={
                  s.id === "files" && config.adapter === "tcp-banner"
                    ? "Low TCP-баннер не обслуживает файлы"
                    : undefined
                }
                aria-label={s.title}
                aria-current={section === s.id ? "page" : undefined}
                className={section === s.id ? "active" : ""}
                onClick={() => {
                  setSection(s.id);
                  if (s.id !== "files") setFocusEditor(false);
                  endGroup();
                }}
              >
                {s.title}
                {s.id === "files" && (
                  <span>{config.decoy_files?.length ?? 0}</span>
                )}
              </button>
            ))}
          </nav>
          <ErrorNotice error={mutation.error} />
          {section === "legend" && (
            <div className="studio-legend-form">
              <Field label="Название профиля" error={errors.name}>
                <input
                  value={name}
                  maxLength={100}
                  disabled={!!id}
                  onChange={(e) =>
                    change({ ...draft, name: e.target.value }, "name")
                  }
                  onBlur={() => checkField("name")}
                  placeholder="Архив резервных копий"
                />
              </Field>
              <div className="studio-form-row">
                <Field label="Протокол">
                  <select
                    value={config.adapter}
                    disabled={!!id}
                    onChange={(e) => switchAdapter(e.target.value as Adapter)}
                  >
                    <option value="http">HTTP-портал</option>
                    <option value="cowrie">SSH-среда · Medium</option>
                    <option value="tcp-banner">TCP-баннер · Low</option>
                  </select>
                </Field>
                <Field label="Образ сервиса">
                  <select
                    value={preset}
                    onChange={(e) => applyPreset(e.target.value)}
                  >
                    <option value="">Выбрать образ</option>
                    {(!id || config.adapter === "http") && (
                      <>
                        <option value="assets">Консоль инфраструктуры</option>
                        <option value="vault">Архив резервных копий</option>
                      </>
                    )}
                    {(!id || config.adapter === "tcp-banner") && (
                      <option value="banner">TCP-служба</option>
                    )}
                    {(!id || config.adapter === "cowrie") && (
                      <option value="bastion">Сервер разработки</option>
                    )}
                  </select>
                </Field>
              </div>
              <p className="permission-note">{levelLabel(config.adapter)}</p>
              {config.schema_version === 1 && (
                <div className="studio-legacy-note">
                  <p className="permission-note">
                    Историческая схема v1. Она остаётся без автоматического
                    преобразования. Настройки порта, учётных записей и сбора
                    доступны в v2.
                  </p>
                  <button
                    className="button small"
                    type="button"
                    onClick={() => patch(upgradeConfig(config))}
                  >
                    Перейти к настройкам v2
                  </button>
                </div>
              )}
              <Field label="Название сервиса" error={errors.persona}>
                <input
                  value={config.persona}
                  maxLength={80}
                  onBlur={() => checkField("persona")}
                  onChange={(e) =>
                    patch({ persona: e.target.value }, "persona")
                  }
                />
              </Field>
              <Field label="Имя хоста" error={errors.hostname}>
                <input
                  value={config.hostname}
                  className="mono"
                  maxLength={63}
                  onBlur={() => checkField("hostname")}
                  onChange={(e) =>
                    patch({ hostname: e.target.value }, "hostname")
                  }
                />
              </Field>
              {config.adapter === "tcp-banner" && (
                <>
                  <Field label="Баннер TCP" error={errors.banner}>
                    <input
                      className="mono"
                      maxLength={256}
                      value={config.banner}
                      onChange={(e) =>
                        patch({ banner: e.target.value }, "banner")
                      }
                      onBlur={() => checkField("banner")}
                    />
                  </Field>
                  <Field label="Ответ на TCP-запрос" error={errors.response}>
                    <input
                      maxLength={256}
                      value={config.response}
                      onChange={(e) =>
                        patch({ response: e.target.value }, "response")
                      }
                      onBlur={() => checkField("response")}
                    />
                  </Field>
                </>
              )}
              <details
                className="studio-advanced"
                open={advanced}
                onToggle={(e) => setAdvanced(e.currentTarget.open)}
              >
                <summary>Дополнительные настройки</summary>
                <div>
                  <Field label="Описание" error={errors.description}>
                    <textarea
                      rows={2}
                      maxLength={500}
                      disabled={!!id}
                      value={description}
                      onBlur={() => checkField("description")}
                      onChange={(e) =>
                        change(
                          { ...draft, description: e.target.value },
                          "description",
                        )
                      }
                      placeholder="Назначение профиля"
                    />
                  </Field>
                  {config.adapter === "http" ? (
                    <>
                      <Field label="Страница входа">
                        <select
                          value={config.template}
                          onChange={(e) =>
                            patch({
                              template: e.target.value as
                                "asset-console" | "file-vault",
                            })
                          }
                        >
                          <option value="asset-console">Консоль активов</option>
                          <option value="file-vault">Файловое хранилище</option>
                        </select>
                      </Field>
                      <Field
                        label="Баннер HTTP-сервера"
                        error={errors.server_banner}
                      >
                        <input
                          className="mono"
                          value={config.server_banner}
                          maxLength={64}
                          onBlur={() => checkField("server_banner")}
                          onChange={(e) =>
                            patch(
                              { server_banner: e.target.value },
                              "server_banner",
                            )
                          }
                        />
                      </Field>
                    </>
                  ) : config.adapter === "cowrie" ? (
                    <>
                      <Field label="Баннер SSH" error={errors.ssh_banner}>
                        <input
                          className="mono"
                          value={config.ssh_banner}
                          maxLength={88}
                          onBlur={() => checkField("ssh_banner")}
                          onChange={(e) =>
                            patch({ ssh_banner: e.target.value }, "ssh_banner")
                          }
                        />
                      </Field>
                      <Field
                        label="Загрузка файлов"
                        error={errors.download_mode}
                        hint="Лабораторный режим разрешает получение безопасного образца с единственного локального адреса."
                      >
                        <select
                          value={config.download_mode ?? "blocked"}
                          onChange={(e) =>
                            patch(
                              {
                                download_mode: e.target.value as
                                  "blocked" | "fixture",
                              },
                              "download_mode",
                            )
                          }
                        >
                          <option value="blocked">Запрещена</option>
                          {config.adapter === "cowrie" && (
                            <option value="fixture">
                              Лабораторный образец
                            </option>
                          )}
                        </select>
                      </Field>
                      {config.download_mode === "fixture" && (
                        <div className="studio-download-example">
                          <strong>Команда для развёрнутой SSH-ловушки</strong>
                          <code>
                            wget
                            http://downloads.honeyforge.test:18090/sample.txt
                          </code>
                          <p>
                            Настоящая загрузка безопасного образца. Интернет и
                            другие адреса недоступны. Предпросмотр не выполняет
                            эту команду.
                          </p>
                        </div>
                      )}
                    </>
                  ) : null}
                  {config.schema_version === 2 && (
                    <ProfileSettings
                      config={config}
                      patch={patch}
                      errors={errors}
                      endGroup={endGroup}
                    />
                  )}
                </div>
              </details>
            </div>
          )}
          {section === "files" && (
            <Suspense fallback={<Loading />}>
              <StudioFiles
                config={config}
                patch={patch}
                errors={errors}
                endGroup={endGroup}
                onSelect={setSelectedFile}
                focusEditor={focusEditor}
                onToggleFocus={() => setFocusEditor((value) => !value)}
              />
            </Suspense>
          )}
          {section === "limits" && (
            <div className="studio-limits-form">
              {(
                [
                  {
                    key: "memory_mb",
                    label: "Память",
                    unit: "MB",
                    min: 64,
                    max: 512,
                    step: 1,
                  },
                  {
                    key: "cpu",
                    label: "Процессор",
                    unit: "CPU",
                    min: 0.1,
                    max: 2,
                    step: 0.1,
                  },
                  {
                    key: "pids",
                    label: "Процессы",
                    unit: "PID",
                    min: 32,
                    max: 256,
                    step: 1,
                  },
                ] as const
              ).map((l) => (
                <div className="studio-resource-control" key={l.key}>
                  <label htmlFor={`limit-${l.key}`}>{l.label}</label>
                  <div className="studio-resource-value">
                    <input
                      id={`limit-${l.key}`}
                      aria-label={`${l.label}, ${l.unit}`}
                      type="number"
                      min={l.min}
                      max={l.max}
                      step={l.step}
                      value={limits[l.key]}
                      onBlur={endGroup}
                      onChange={(e) =>
                        patch(
                          {
                            limits: {
                              ...limits,
                              [l.key]: Number(e.target.value),
                            },
                          },
                          l.key,
                        )
                      }
                    />
                    <span>{l.unit}</span>
                  </div>
                  <input
                    className="studio-range"
                    aria-label={`Лимит: ${l.label}`}
                    type="range"
                    min={l.min}
                    max={l.max}
                    step={l.step}
                    value={limits[l.key]}
                    onChange={(e) =>
                      patch(
                        {
                          limits: {
                            ...limits,
                            [l.key]: Number(e.target.value),
                          },
                        },
                        l.key,
                      )
                    }
                    onPointerUp={endGroup}
                    onKeyUp={endGroup}
                  />
                  <small>
                    {l.min}–{l.max} {l.unit}
                  </small>
                  {(errors[l.key] || errors[`limits.${l.key}`]) && (
                    <p className="bad" role="alert">
                      {errors[l.key] || errors[`limits.${l.key}`]}
                    </p>
                  )}
                </div>
              ))}
              <p className="studio-resource-note">
                Лимиты применяются к контейнеру при развёртывании.
              </p>
            </div>
          )}
        </section>
        <StudioPreview config={config} selectedPath={selectedFile} />
      </div>
      <div className="studio-statusbar" role={recovered ? "status" : undefined}>
        {recovered ? "Восстановлен черновик из этой вкладки" : saveStatus}
      </div>
      <Modal
        open={review}
        onClose={() => {
          if (!mutation.isPending) setReview(false);
        }}
        title="Проверьте перед публикацией"
        description={
          id
            ? `Версия ${(existing.data?.latest_version ?? 0) + 1} профиля «${name}».`
            : `Профиль «${name}». Первая версия.`
        }
      >
        <div className="studio-review">
          <KeyValue label="Протокол">{adapterLabels[config.adapter]}</KeyValue>
          <KeyValue label="Уровень">{levelLabel(config.adapter)}</KeyValue>
          <KeyValue label="Схема профиля">v{config.schema_version}</KeyValue>
          {config.schema_version === 2 && (
            <>
              <KeyValue label="Рекомендуемый порт">
                {config.recommended_port}
              </KeyValue>
              {config.adapter !== "tcp-banner" && (
                <>
                  {config.decoy_accounts && (
                    <KeyValue label="Тестовые учётные записи">
                      {config.decoy_accounts.length}
                    </KeyValue>
                  )}
                  {config.recording && (
                    <>
                      <KeyValue label="Сбор учётных данных">
                        {config.recording.capture_credentials
                          ? "Включён"
                          : "Выключен"}
                      </KeyValue>
                      <KeyValue
                        label={
                          config.adapter === "http"
                            ? "Лимит HTTP payload"
                            : "Лимит вывода SSH"
                        }
                      >
                        {config.adapter === "http"
                          ? config.recording.http_payload_bytes
                          : config.recording.shell_output_bytes}{" "}
                        байт
                      </KeyValue>
                    </>
                  )}
                </>
              )}
              {config.beacon && (
                <KeyValue label="Интервал сигнала агента">
                  {config.beacon.interval_seconds} с · разброс{" "}
                  {Math.round(config.beacon.jitter_ratio * 100)}%
                </KeyValue>
              )}
            </>
          )}
          <KeyValue label="Сервис">{config.persona}</KeyValue>
          {config.adapter === "cowrie" && (
            <KeyValue label="Загрузка файлов">
              {config.download_mode === "fixture"
                ? "Лабораторный образец"
                : "Запрещена"}
            </KeyValue>
          )}
          <KeyValue label="Хост">
            <code>{config.hostname}</code>
          </KeyValue>
          <KeyValue label="Файлы">
            {fileCount(config.decoy_files?.length ?? 0)}
          </KeyValue>
          <KeyValue label="Ресурсы">
            {limits.memory_mb} MB, {limits.cpu} CPU, {limits.pids} PID
          </KeyValue>
          <details>
            <summary>Конфигурация JSON</summary>
            <Code value={config} />
          </details>
          <div className="actions">
            <button
              type="button"
              className="button"
              onClick={() => draftFile(config)}
            >
              <Download size={15} />
              Скачать JSON
            </button>
            <button
              type="button"
              className="button primary"
              disabled={
                mutation.isPending || Boolean(existing.data?.archived_at)
              }
              onClick={() => {
                if (!existing.data?.archived_at) mutation.mutate();
              }}
            >
              {mutation.isPending ? "Публикуем…" : "Опубликовать версию"}
              <Check size={15} />
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
