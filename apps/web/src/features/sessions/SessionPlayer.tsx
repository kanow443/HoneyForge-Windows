import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  Pause,
  Play,
  Radio,
  RotateCcw,
  ShieldAlert,
  Terminal,
  Maximize2,
  Minimize2,
} from "lucide-react";
import type { Finding, PlaybackEvent } from "../../shared/api/models";
import { Code, time } from "../../shared/ui";
import { useContentMotion } from "../../shared/ui/motion";
import { eventLabel, eventSummary, eventNote } from "../events/presentation";
import { PrivateCapture } from "../evidence/PrivateCapture";
import { ArtifactReference } from "../evidence/ArtifactReference";
import { FindingTime } from "../analysis/FindingTime";
import {
  elapsed,
  eventOffsets,
  lastVisible,
  safePayload,
  terminalText,
} from "./playback";

const eventCount = (n: number) =>
  `${n} ${n % 10 === 1 && n % 100 !== 11 ? "событие" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "события" : "событий"}`;
export function SessionPlayer({
  events,
  findings,
  selected,
  onFinding,
  connection,
  ended,
  catchUp,
  fetching,
  lastReceived,
}: {
  events: PlaybackEvent[];
  findings: Finding[];
  selected: string | null;
  onFinding: (id: string | null) => void;
  connection: string;
  ended: boolean;
  catchUp: () => Promise<unknown>;
  fetching: boolean;
  lastReceived?: string;
}) {
  const [mode, setMode] = useState<"live" | "paused" | "replay">("live"),
    [snapshot, setSnapshot] = useState(events),
    [position, setPosition] = useState(0),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(1),
    [following, setFollowing] = useState(true),
    [catching, setCatching] = useState(false),
    [failure, setFailure] = useState(""),
    [expanded, setExpanded] = useState(false);
  const findingMotion = useContentMotion<HTMLDivElement>(selected);
  const visibleEvents = mode === "live" ? events : snapshot,
    offsets = useMemo(() => eventOffsets(visibleEvents), [visibleEvents]),
    duration = offsets.at(-1) ?? 0,
    count =
      mode === "replay" ? lastVisible(offsets, position) : visibleEvents.length,
    shown = visibleEvents.slice(Math.max(0, count - 250), count),
    finding = findings.find((f) => f.id === selected),
    evidence = new Set(finding?.evidence_ids ?? []),
    snapshotIds = useMemo(() => new Set(snapshot.map((e) => e.id)), [snapshot]),
    missed =
      mode === "live" ? 0 : events.filter((e) => !snapshotIds.has(e.id)).length;
  const hasOutput = visibleEvents.some((e) => e.event_type === "ssh.output"),
    incompleteOutput = visibleEvents.some(
      (e) =>
        e.event_type === "sensor.error" && e.payload.capture === "shell-output",
    );
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!expanded) return;
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [expanded]);
  useEffect(() => {
    if (mode !== "replay" || !playing) return;
    let previous = Date.now();
    const timer = setInterval(() => {
      const now = Date.now(),
        delta = (now - previous) * speed;
      previous = now;
      setPosition((p) => Math.min(duration, p + delta));
    }, 100);
    return () => clearInterval(timer);
  }, [mode, playing, speed, duration]);
  useEffect(() => {
    if (playing && position >= duration) setPlaying(false);
  }, [playing, position, duration]);
  useEffect(() => {
    if (following && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [count, mode, following]);
  function pauseLive() {
    setSnapshot(events);
    setPosition(eventOffsets(events).at(-1) ?? 0);
    setMode("paused");
    setPlaying(false);
  }
  function replay(at = 0) {
    setSnapshot(events);
    setMode("replay");
    setPosition(at);
    setPlaying(false);
    setFollowing(true);
  }
  function seek(value: number) {
    if (mode !== "replay") setSnapshot(events);
    setMode("replay");
    setPosition(value);
    setPlaying(false);
    setFollowing(true);
  }
  async function goLive() {
    setCatching(true);
    setFailure("");
    try {
      await catchUp();
      setMode("live");
      setPlaying(false);
      setFollowing(true);
      onFinding(null);
    } catch {
      setFailure("Не удалось загрузить пропущенное. Повторите попытку.");
    } finally {
      setCatching(false);
    }
  }
  function chooseFinding(f: Finding) {
    onFinding(f.id);
    const index = events.findIndex(
      (e) =>
        f.evidence_ids.includes(e.id) || f.evidence_ids.includes(e.event_id),
    );
    if (index >= 0) replay(eventOffsets(events)[index]);
  }
  // A finding deep link also works after all cursor pages have loaded.
  const positioned = useRef<string | null>(null);
  useEffect(() => {
    if (!finding) {
      positioned.current = null;
      return;
    }
    if (positioned.current === finding.id) return;
    const index = events.findIndex(
      (e) =>
        finding.evidence_ids.includes(e.id) ||
        finding.evidence_ids.includes(e.event_id),
    );
    if (index >= 0) {
      positioned.current = finding.id;
      replay(eventOffsets(events)[index]);
    }
  }, [selected, events]);
  return (
    <section
      className={`session-player ${expanded ? "is-expanded" : ""}`}
      aria-label="Плеер сессии"
    >
      <div className="player-main">
        <div className="player-topbar">
          <span
            className={`player-mode ${mode === "live" && !ended ? "is-live" : ""}`}
          >
            {mode === "live" ? <Radio size={15} /> : <RotateCcw size={15} />}
            {mode === "live"
              ? ended
                ? "История завершённой сессии"
                : "LIVE"
              : mode === "paused"
                ? "Просмотр на паузе"
                : "REPLAY"}
          </span>
          <span>
            {mode === "live"
              ? connection === "connected"
                ? "Связь установлена"
                : connection === "offline"
                  ? "Нет сети"
                  : "Восстанавливаем связь"
              : ended
                ? "Сохранённая история"
                : "Сбор событий продолжается"}
          </span>
          <small>
            {count} из {visibleEvents.length} событий
          </small>
          <button
            className="player-expand"
            aria-label={expanded ? "Свернуть плеер" : "Развернуть плеер"}
            title={expanded ? "Свернуть · Esc" : "Развернуть плеер"}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        </div>
        <div
          className="player-terminal"
          ref={scroller}
          tabIndex={0}
          aria-label="Поток событий сессии"
          onScroll={() => {
            const el = scroller.current;
            if (el)
              setFollowing(
                el.scrollHeight - el.scrollTop - el.clientHeight < 40,
              );
          }}
        >
          <div className="terminal-intro">
            <Terminal size={16} />
            <span>Сохранённые команды и события</span>
            <small>
              {hasOutput
                ? "С сохранённым выводом SSH"
                : "Записанных фрагментов вывода нет"}
            </small>
          </div>
          {incompleteOutput && (
            <p role="status" className="terminal-capture-warning">
              Запись вывода неполная: сенсор сообщил об ограничении объёма.
              Подробности — в событии ошибки.
            </p>
          )}
          {count > 250 && (
            <p className="terminal-window-note">
              Показаны последние 250 из {count} событий. Используйте шкалу для
              просмотра начала.
            </p>
          )}
          {shown.map((e) => (
            <article
              key={e.id}
              className={`player-event ${evidence.has(e.id) || evidence.has(e.event_id) ? "is-evidence" : ""}`}
              data-event-id={e.id}
            >
              <time dateTime={e.observed_at}>
                {new Date(e.observed_at).toLocaleTimeString("ru-RU", {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </time>
              <div>
                <div className="player-event-label">
                  {eventLabel(e.event_type)}
                </div>
                <pre
                  className={
                    e.event_type === "ssh.command"
                      ? "player-command"
                      : e.event_type === "ssh.output"
                        ? "player-output"
                        : ""
                  }
                >
                  {e.event_type === "ssh.command" && (
                    <span aria-hidden="true">$ </span>
                  )}
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
                <details>
                  <summary>Исходное событие</summary>
                  <div className="event-proof">
                    {eventNote(e.event_type) && (
                      <p>{eventNote(e.event_type)}</p>
                    )}
                    <ArtifactReference event={e} />
                    <PrivateCapture key={e.id} event={e} />
                    <span>Получено: {time(e.created_at, true)}</span>
                    <span>Порядок источника: {e.source_seq}</span>
                    <span>Источник данных: {e.provenance}</span>
                    <code>Evidence ID: {e.id}</code>
                    <Code value={safePayload(e.payload)} />
                  </div>
                </details>
              </div>
            </article>
          ))}
          {!count && (
            <p className="terminal-empty">
              Ожидаем первое сохранённое событие.
            </p>
          )}
        </div>
        {!following && (
          <button
            className="player-follow"
            onClick={() => {
              setFollowing(true);
              if (scroller.current)
                scroller.current.scrollTop = scroller.current.scrollHeight;
            }}
          >
            <ArrowDown size={14} />К последней строке
          </button>
        )}
        <div className="player-controls">
          <div className="player-timeline">
            <input
              type="range"
              aria-label="Позиция воспроизведения"
              min={0}
              max={Math.max(1, duration)}
              step={1}
              value={mode === "live" ? duration : position}
              onChange={(e) => seek(Number(e.target.value))}
            />
            <div className="player-markers">
              {findings.map((f) => {
                const i = visibleEvents.findIndex(
                  (e) =>
                    f.evidence_ids.includes(e.id) ||
                    f.evidence_ids.includes(e.event_id),
                );
                return i < 0 ? null : (
                  <button
                    key={f.id}
                    style={{
                      left: `${Math.min(98, Math.max(2, (offsets[i] / Math.max(1, duration)) * 100))}%`,
                    }}
                    className={`marker-${f.severity}`}
                    aria-label={`Перейти к срабатыванию: ${f.title}`}
                    title={f.title}
                    onClick={() => chooseFinding(f)}
                  />
                );
              })}
            </div>
          </div>
          <div className="player-control-row">
            {mode === "live" ? (
              <button
                className="player-button"
                onClick={pauseLive}
                aria-label="Приостановить просмотр"
              >
                <Pause size={16} />
              </button>
            ) : (
              <button
                className="player-button"
                aria-label={
                  playing ? "Приостановить воспроизведение" : "Воспроизвести"
                }
                onClick={() => {
                  if (mode === "paused") replay();
                  if (position >= duration) setPosition(0);
                  setMode("replay");
                  setPlaying((v) => !v);
                }}
                disabled={!events.length}
              >
                <>{playing ? <Pause size={16} /> : <Play size={16} />}</>
              </button>
            )}
            <button
              className="player-button"
              aria-label="Воспроизвести с начала"
              onClick={() => {
                replay();
                setPlaying(true);
              }}
              disabled={!events.length}
            >
              <RotateCcw size={15} />
            </button>
            <code>
              {elapsed(mode === "live" ? duration : position)} <span>из</span>{" "}
              {elapsed(duration)}
            </code>
            <label className="player-speed">
              Скорость
              <select
                aria-label="Скорость воспроизведения"
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
              >
                {[1, 2, 4].map((x) => (
                  <option key={x} value={x}>
                    ×{x}
                  </option>
                ))}
              </select>
            </label>
            <button
              className={`player-live-button ${mode === "live" ? "current" : ""}`}
              disabled={catching}
              onClick={goLive}
            >
              {catching
                ? "Загружаем историю…"
                : ended
                  ? "К последней записи"
                  : mode === "live"
                    ? fetching
                      ? "Обновляем…"
                      : "LIVE"
                    : missed
                      ? `В LIVE · ${missed} новых`
                      : "Вернуться в LIVE"}
            </button>
          </div>
          <div className="player-footnote">
            <span>
              {lastReceived
                ? `Последнее получение: ${time(lastReceived)}`
                : "Событий пока нет"}
            </span>
            <span>Пауза останавливает только просмотр</span>
          </div>
          {failure && (
            <p role="alert" className="bad">
              {failure}
            </p>
          )}
        </div>
      </div>
      <aside className="player-evidence">
        <div className="player-evidence-heading">
          <ShieldAlert size={17} />
          <h2>Срабатывания правил</h2>
          <span>{findings.length}</span>
        </div>
        {!findings.length && (
          <p className="quiet-empty">Срабатываний в этой сессии нет.</p>
        )}
        {!finding &&
          findings.map((f) => {
            const observed = events.find(
              (e) =>
                f.evidence_ids.includes(e.id) ||
                f.evidence_ids.includes(e.event_id),
            );
            return (
              <button
                aria-label={`Открыть правило: ${f.title}`}
                className={`player-finding ${selected === f.id ? "selected" : ""}`}
                key={f.id}
                onClick={() => chooseFinding(f)}
              >
                <span className={`finding-severity severity-${f.severity}`}>
                  {{
                    high: "Высокая важность",
                    medium: "Средняя важность",
                    low: "Низкая важность",
                  }[f.severity] ?? f.severity}
                </span>
                <strong>{f.title}</strong>
                <FindingTime finding={f} />
                <code className="finding-command">
                  {observed
                    ? terminalText(eventSummary(observed))
                    : "Событие ещё не загружено"}
                </code>
                <small>
                  {eventCount(f.evidence_ids.length)} · {time(f.created_at)}
                </small>
              </button>
            );
          })}
        {finding && (
          <div ref={findingMotion} className="player-finding-detail">
            <h3>{finding.title}</h3>
            <p>{finding.explanation}</p>
            <span>
              {finding.observation === "intent"
                ? "Намерение в эмуляторе"
                : "Наблюдаемое действие"}
            </span>
            <code>
              {finding.rule_id} · v{finding.rule_version}
            </code>
            <h4>Подтверждающие события</h4>
            {finding.evidence_ids.map((id) => {
              const ev = events.find((e) => e.id === id || e.event_id === id);
              return (
                <button
                  className="evidence-link"
                  key={id}
                  disabled={!ev}
                  onClick={() => {
                    if (ev) replay(eventOffsets(events)[events.indexOf(ev)]);
                  }}
                >
                  {ev ? eventLabel(ev.event_type) : "Событие не загружено"}
                  <code>{id}</code>
                </button>
              );
            })}
            <button className="text-link" onClick={() => onFinding(null)}>
              К срабатываниям
            </button>
          </div>
        )}
      </aside>
    </section>
  );
}
