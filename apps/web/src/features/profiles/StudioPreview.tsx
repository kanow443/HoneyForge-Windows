import { useEffect, useRef, useState } from "react";
import { RotateCcw, Terminal } from "lucide-react";
import { MotionIndicator, useContentMotion } from "../../shared/ui/motion";
import type { Config } from "../../shared/api/models";
type PreviewTab = "service" | "files";
export function StudioPreview({
  config,
  selectedPath,
}: {
  config: Config;
  selectedPath?: string;
}) {
  const [tab, setTab] = useState<PreviewTab>("service"),
    [file, setFile] = useState(0),
    [loginError, setLoginError] = useState(false),
    [command, setCommand] = useState(""),
    [history, setHistory] = useState<{ input: string; output: string }[]>([]);
  const terminalOutput = useRef<HTMLDivElement>(null),
    previewUser =
      config.schema_version === 2
        ? config.decoy_accounts?.[0]?.username || "demo.user"
        : "root",
    files = config.decoy_files ?? [],
    selected = files[file] ?? files[0],
    currentFile = files.find((f) => f.path === selectedPath) ?? selected;
  const previewMotion = useContentMotion<HTMLDivElement>(
    `${tab}:${config.adapter}:${tab === "files" ? file : ""}`,
  );
  useEffect(() => {
    const index = files.findIndex((f) => f.path === selectedPath);
    if (index >= 0) setFile(index);
  }, [selectedPath]);
  useEffect(() => {
    setTab("service");
    setLoginError(false);
    setHistory([]);
    setCommand("");
  }, [config.adapter]);
  useEffect(() => {
    if (file >= files.length) setFile(0);
  }, [file, files.length]);
  useEffect(() => {
    if (terminalOutput.current)
      terminalOutput.current.scrollTop = terminalOutput.current.scrollHeight;
  }, [history]);
  function run(value: string) {
    const input = value.trim();
    if (!input) return;
    let output = "";
    if (input === "hostname") output = config.hostname;
    else if (input === "whoami") output = previewUser;
    else if (input === "ls" || input.startsWith("ls ")) {
      const dir = input.slice(2).trim() || "/opt/decoy";
      output = files
        .filter((f) => f.path.startsWith(dir.replace(/\/$/, "") + "/"))
        .map((f) => f.path.split("/").at(-1))
        .join("  ");
    } else if (input.startsWith("cat ")) {
      const path = input.slice(4).trim();
      output =
        files.find((f) => f.path === path)?.content ??
        `cat: ${path}: No such file or directory`;
    } else output = "В предпросмотре доступны hostname, whoami, ls и cat.";
    setHistory((h) => [...h.slice(-11), { input, output }]);
    setCommand("");
  }
  return (
    <aside className="studio-preview" aria-label="Предпросмотр ловушки">
      <div className="studio-preview-toolbar">
        <div role="tablist" aria-label="Режим предпросмотра">
          <MotionIndicator active={tab} />
          {(
            [
              { id: "service", label: "Сервис" },
              { id: "files", label: "Файлы" },
            ] as const
          ).map((t) => (
            <button
              type="button"
              role="tab"
              id={`studio-tab-${t.id}`}
              key={t.id}
              disabled={t.id === "files" && config.adapter === "tcp-banner"}
              tabIndex={tab === t.id ? 0 : -1}
              aria-selected={tab === t.id}
              aria-controls="studio-preview-content"
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => {
                if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key))
                  return;
                e.preventDefault();
                if (config.adapter === "tcp-banner") return;
                const next =
                  e.key === "Home"
                    ? "service"
                    : e.key === "End"
                      ? "files"
                      : tab === "service"
                        ? "files"
                        : "service";
                setTab(next);
                e.currentTarget.parentElement
                  ?.querySelector<HTMLButtonElement>(`#studio-tab-${next}`)
                  ?.focus();
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span>Предпросмотр</span>
        <button
          type="button"
          className="icon-button"
          aria-label="Сбросить предпросмотр"
          title="Сбросить предпросмотр"
          onClick={() => {
            setLoginError(false);
            setHistory([]);
            setCommand("");
          }}
        >
          <RotateCcw size={16} />
        </button>
      </div>
      <div
        ref={previewMotion}
        id="studio-preview-content"
        className={`studio-preview-content ${tab === "service" && config.adapter.startsWith("cowrie") ? "is-terminal" : ""}`}
        role="tabpanel"
        aria-labelledby={`studio-tab-${tab}`}
      >
        {tab === "service" &&
          (config.adapter === "http" ? (
            <div className="studio-portal-canvas">
              <form
                className="studio-portal"
                autoComplete="off"
                onSubmit={(e) => {
                  e.preventDefault();
                  setLoginError(true);
                }}
              >
                <div className="studio-portal-persona">
                  {config.persona || "Название сервиса"}
                </div>
                <h3>
                  {config.template === "file-vault"
                    ? "File Vault"
                    : "Asset Console"}
                </h3>
                <p>Sign in to your workspace.</p>
                {loginError && (
                  <p className="studio-portal-error" role="status">
                    Invalid credentials. Please try again.
                  </p>
                )}
                <label>
                  Username
                  <input
                    name="preview-username"
                    aria-label="Имя пользователя в предпросмотре"
                    placeholder={
                      config.schema_version === 2
                        ? config.decoy_accounts?.[0]?.username || "demo.user"
                        : "operator"
                    }
                    autoComplete="off"
                  />
                </label>
                <label>
                  Password
                  <input
                    name="preview-password"
                    type="password"
                    aria-label="Пароль в предпросмотре"
                    placeholder="Password"
                    autoComplete="new-password"
                  />
                </label>
                <button type="submit">Sign in</button>
                <small>{config.hostname}</small>
              </form>
            </div>
          ) : config.adapter === "tcp-banner" ? (
            <div className="studio-banner-preview">
              <h3>{config.persona}</h3>
              <p className="permission-note">TCP · Low · {config.hostname}</p>
              <h4>Баннер при подключении</h4>
              <pre>{config.banner || "Баннер пока пуст"}</pre>
              <h4>Ответ на запрос</h4>
              <pre>{config.response || "Ответ не отправляется"}</pre>
              <p className="permission-note">
                Простой обмен строками. Вход, команды и файловая система
                отсутствуют. Предпросмотр не открывает сетевое соединение.
              </p>
            </div>
          ) : (
            <div className="studio-terminal-shell">
              <div className="studio-terminal-title">
                <Terminal size={15} />
                <span>{config.hostname}</span>
                <small>Пробный сеанс</small>
              </div>
              <div
                className="studio-terminal-output"
                ref={terminalOutput}
                aria-label="Пробный сеанс SSH"
              >
                <div className="studio-terminal-banner">
                  {config.ssh_banner}
                </div>
                {!history.length && (
                  <div className="studio-terminal-hint">
                    Введите hostname, ls или cat.
                  </div>
                )}
                {history.map((h, i) => (
                  <div className="studio-terminal-entry" key={i}>
                    <div>
                      <span>
                        {previewUser}@{config.hostname}:~$
                      </span>{" "}
                      {h.input}
                    </div>
                    {h.output && <pre>{h.output}</pre>}
                  </div>
                ))}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    run(command);
                  }}
                >
                  <label htmlFor="studio-command">
                    {previewUser}@{config.hostname}:~$
                  </label>
                  <input
                    id="studio-command"
                    aria-label="Команда в предпросмотре SSH"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="hostname"
                  />
                </form>
              </div>
              <div className="studio-terminal-shortcuts">
                <button type="button" onClick={() => run("ls /opt/decoy")}>
                  Показать файлы
                </button>
                {currentFile && (
                  <button
                    type="button"
                    title={`cat ${currentFile.path}`}
                    aria-label={`cat ${currentFile.path}`}
                    onClick={() => run(`cat ${currentFile.path}`)}
                  >
                    Прочитать файл
                  </button>
                )}
              </div>
            </div>
          ))}
        {tab === "files" && (
          <div className="studio-file-preview">
            <div className="studio-preview-file-list">
              {files.map((f, i) => (
                <button
                  type="button"
                  key={i}
                  aria-pressed={file === i}
                  onClick={() => setFile(i)}
                  title={f.path}
                >
                  {f.path.split("/").at(-1)}
                </button>
              ))}
            </div>
            {selected ? (
              <>
                <code className="studio-file-path">{selected.path}</code>
                <pre>{selected.content || "Файл пока пуст"}</pre>
              </>
            ) : (
              <p className="studio-preview-empty">Пока нет файлов</p>
            )}
          </div>
        )}
      </div>
      <div className="studio-preview-note">Локальный предпросмотр</div>
    </aside>
  );
}
