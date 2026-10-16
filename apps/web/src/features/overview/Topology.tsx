import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Globe, Server, Terminal, X } from "lucide-react";
import { adapterLabel } from "../profiles/config";
import { api } from "../../shared/api/client";
import type { Topology } from "../../shared/api/models";
import { ErrorNotice, Status, time } from "../../shared/ui";
import { MotionIndicator, useContentMotion } from "../../shared/ui/motion";
type Selection = { type: "source" | "deployment" | "host"; id: string } | null;
export function filteredLinks(data: Topology, selected: Selection) {
  return data.links.filter(
    (link) =>
      !selected ||
      (selected.type === "source"
        ? link.source_ip === selected.id
        : selected.type === "deployment"
          ? link.deployment_id === selected.id
          : data.deployments.find((d) => d.id === link.deployment_id)
              ?.host_id === selected.id),
  );
}
export function TopologyPanel() {
  const [hours, setHours] = useState(24),
    [selected, setSelected] = useState<Selection>(null),
    [view, setView] = useState<"sessions" | "connections">("sessions"),
    [pulse, setPulse] = useState<string[]>([]);
  const tableMotion = useContentMotion<HTMLDivElement>(view);
  const q = useQuery({
      queryKey: ["topology", hours],
      queryFn: () => api.topology(hours),
      refetchInterval: 10000,
    }),
    navigate = useNavigate();
  const seen = useRef(new Map<string, number>()),
    pulsed = useRef(new Map<string, number>()),
    initialized = useRef(false),
    pulseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(pulseTimer.current), []);
  useEffect(() => {
    initialized.current = false;
    seen.current.clear();
    setSelected(null);
  }, [hours]);
  useEffect(() => {
    if (!q.data) return;
    const fresh: string[] = [];
    for (const link of q.data.links) {
      const key = link.source_ip + "|" + link.deployment_id,
        old = seen.current.get(key);
      if (
        initialized.current &&
        (old === undefined || link.event_count > old) &&
        Date.now() - (pulsed.current.get(key) ?? 0) > 5000
      ) {
        fresh.push(key);
        pulsed.current.set(key, Date.now());
      }
      seen.current.set(key, link.event_count);
    }
    initialized.current = true;
    if (fresh.length) {
      setPulse(fresh);
      clearTimeout(pulseTimer.current);
      pulseTimer.current = setTimeout(() => setPulse([]), 2200);
    }
  }, [q.data]);
  const data = q.data,
    links = useMemo(
      () => (data ? filteredLinks(data, selected) : []),
      [data, selected],
    ),
    activeIds = new Set(links.map((l) => l.deployment_id)),
    activeSources = new Set(links.map((l) => l.source_ip)),
    sources =
      data?.sources
        .filter((s) => !selected || activeSources.has(s.source_ip))
        .slice(0, 6) ?? [],
    deployments =
      data?.deployments
        .slice()
        .sort(
          (a, b) =>
            Number(b.state === "running") - Number(a.state === "running"),
        )
        .filter(
          (d) =>
            !selected ||
            activeIds.has(d.id) ||
            (selected.type === "deployment" && d.id === selected.id) ||
            (selected.type === "host" && d.host_id === selected.id),
        )
        .slice(0, 6) ?? [],
    hosts =
      data?.hosts
        .filter(
          (h) =>
            !selected ||
            deployments.some((d) => d.host_id === h.id) ||
            (selected.type === "host" && selected.id === h.id),
        )
        .slice(0, 6) ?? [],
    height = Math.max(
      250,
      Math.max(sources.length, deployments.length, hosts.length) * 80 + 30,
    ),
    sessions = (data?.sessions ?? []).filter(
      (s) =>
        !selected ||
        (selected.type === "source"
          ? s.source_ip === selected.id
          : selected.type === "deployment"
            ? s.deployment_id === selected.id
            : data?.deployments.find((d) => d.id === s.deployment_id)
                ?.host_id === selected.id),
    );
  function choose(type: NonNullable<Selection>["type"], id: string) {
    setSelected((s) => (s?.type === type && s.id === id ? null : { type, id }));
  }
  function openLink(link: Topology["links"][number]) {
    if (link.session_id) navigate(`/sessions/${link.session_id}`);
    else
      navigate(
        `/events?deployment_id=${link.deployment_id}&source_ip=${encodeURIComponent(link.source_ip)}`,
      );
  }
  return (
    <section className="topology-panel" aria-label="Схема наблюдаемой сети">
      <div className="topology-heading">
        <div>
          <h2>Карта подключений</h2>
          <span>Наблюдаемый источник → ловушка → хост</span>
        </div>
        <label>
          Период
          <select
            aria-label="Период схемы сети"
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
          >
            <option value={6}>6 часов</option>
            <option value={24}>24 часа</option>
          </select>
        </label>
      </div>
      <ErrorNotice error={q.error} onRetry={() => q.refetch()} />
      {q.isPending && (
        <p className="quiet-empty">Загружаем наблюдаемую топологию…</p>
      )}
      {data && (
        <>
          <div className="topology-scroll">
            <div className="topology-column-labels">
              <span>Источники</span>
              <span>Ловушки</span>
              <span>Хосты агентов</span>
            </div>
            <div className="topology-canvas" style={{ height }}>
              <svg
                viewBox={`0 0 1020 ${height}`}
                preserveAspectRatio="none"
                aria-label="Связи сети"
                className="topology-lines"
              >
                {data.links.map((link) => {
                  const source = sources.findIndex(
                      (s) => s.source_ip === link.source_ip,
                    ),
                    deployment = deployments.findIndex(
                      (d) => d.id === link.deployment_id,
                    );
                  if (source < 0 || deployment < 0) return null;
                  const key = link.source_ip + "|" + link.deployment_id,
                    sy = source * 80 + 46,
                    dy = deployment * 80 + 46;
                  return (
                    <g
                      key={key}
                      className={`topology-edge severity-${link.severity} ${pulse.includes(key) ? "new-activity" : ""} ${selected && !links.includes(link) ? "dim" : ""}`}
                      role="link"
                      tabIndex={0}
                      aria-label={`${link.source_ip} → ${deployments[deployment].name}, ${link.event_count} событий`}
                      onClick={() => openLink(link)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") openLink(link);
                      }}
                    >
                      <path
                        className="edge-hit"
                        d={`M 258 ${sy} C 325 ${sy} 345 ${dy} 410 ${dy}`}
                      />
                      <path
                        className="edge-line"
                        d={`M 258 ${sy} C 325 ${sy} 345 ${dy} 410 ${dy}`}
                      />
                    </g>
                  );
                })}
                {deployments.map((d, i) => {
                  const h = hosts.findIndex((h) => h.id === d.host_id);
                  return h < 0 ? null : (
                    <path
                      key={d.id}
                      className={`host-edge ${hosts[h].status === "offline" ? "host-offline" : ""}`}
                      d={`M 650 ${i * 80 + 46} C 713 ${i * 80 + 46} 730 ${h * 80 + 46} 793 ${h * 80 + 46}`}
                    />
                  );
                })}
              </svg>
              <div className="topology-nodes sources">
                {sources.map((s, i) => (
                  <button
                    key={s.source_ip}
                    style={{ top: 16 + i * 80 }}
                    className={`topology-node ${selected?.id === s.source_ip ? "selected" : ""} ${selected && !activeSources.has(s.source_ip) ? "dim" : ""}`}
                    onClick={() => choose("source", s.source_ip)}
                  >
                    <Globe size={16} />
                    <span>
                      <strong className="mono">{s.source_ip}</strong>
                      <small>
                        {s.event_count} событий · {time(s.last_seen)}
                      </small>
                    </span>
                  </button>
                ))}
                {!sources.length && (
                  <p className="topology-empty">Подключений за период нет</p>
                )}
              </div>
              <div className="topology-nodes traps">
                {deployments.map((d, i) => (
                  <button
                    key={d.id}
                    style={{ top: 16 + i * 80 }}
                    className={`topology-node ${selected?.id === d.id ? "selected" : ""}`}
                    onClick={() => choose("deployment", d.id)}
                  >
                    <Terminal size={16} />
                    <span>
                      <strong>{d.name}</strong>
                      <small>
                        {adapterLabel(d.adapter)} · {d.endpoint}
                      </small>
                    </span>
                    <span
                      className={`node-state node-${d.state}`}
                      title={d.state}
                    >
                      {d.state === "running"
                        ? "Работает"
                        : d.state === "unknown"
                          ? "Неизвестно"
                          : d.state === "stopped"
                            ? "Остановлена"
                            : d.state === "error"
                              ? "Ошибка"
                              : d.state === "applying"
                                ? "Запуск"
                                : "Ожидание"}
                    </span>
                  </button>
                ))}
              </div>
              <div className="topology-nodes hosts">
                {hosts.map((h, i) => (
                  <button
                    key={h.id}
                    style={{ top: 16 + i * 80 }}
                    className={`topology-node ${selected?.id === h.id ? "selected" : ""} ${["offline", "revoked"].includes(h.status) ? "offline" : ""}`}
                    onClick={() => choose("host", h.id)}
                  >
                    <Server size={16} />
                    <span>
                      <strong>{h.name}</strong>
                      <small>
                        {h.address} ·{" "}
                        {{
                          online: "На связи",
                          offline: "Не в сети",
                          degraded: "С ограничениями",
                          revoked: "Отозван",
                        }[h.status] ?? h.status}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="topology-caption">
            <span>
              Красный — высокая важность правила. Янтарный — новое наблюдение.
            </span>
            <span>
              {data.sources.length > 6
                ? `На схеме 6 из ${data.sources.length} источников. `
                : ""}
              Все доступные связи — в таблице.
            </span>
          </div>
          {data.truncated && (
            <p className="info-note warn">
              Проекция ограничена 100 источниками, 200 связями и 100 сессиями.
              Полный поиск доступен в <Link to="/events">событиях</Link>.
            </p>
          )}
          <div className="topology-table-heading">
            <div className="topology-table-tabs">
              <MotionIndicator active={view} />
              <button
                className={view === "sessions" ? "active" : ""}
                onClick={() => setView("sessions")}
              >
                Сессии <span>{sessions.length}</span>
              </button>
              <button
                className={view === "connections" ? "active" : ""}
                onClick={() => setView("connections")}
              >
                Связи <span>{links.length}</span>
              </button>
            </div>
            {selected && (
              <button className="text-link" onClick={() => setSelected(null)}>
                <X size={13} />
                Сбросить выбор
              </button>
            )}
            <Link className="text-link" to="/events">
              Все события
              <ArrowRight size={13} />
            </Link>
          </div>
          <div ref={tableMotion} className="topology-table-wrap">
            {view === "sessions" ? (
              sessions.length ? (
                <table>
                  <thead>
                    <tr>
                      <th>Источник</th>
                      <th>Ловушка</th>
                      <th>Начало сессии</th>
                      <th>События</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((s) => (
                      <tr key={s.id}>
                        <td>
                          <code>{s.source_ip}</code>
                          <small>{s.protocol.toUpperCase()}</small>
                        </td>
                        <td>{s.deployment_name}</td>
                        <td>
                          {time(s.started_at)}
                          <small>
                            {s.ended_at
                              ? "Сессия завершена"
                              : "Окончание не получено"}
                          </small>
                        </td>
                        <td>{s.event_count}</td>
                        <td>
                          <Link className="text-link" to={`/sessions/${s.id}`}>
                            Открыть плеер
                            <ArrowRight size={14} />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="quiet-empty">
                  Сессий для выбранного узла нет. Посмотрите связи или события.
                </p>
              )
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Источник</th>
                    <th>Ловушка</th>
                    <th>Наблюдение</th>
                    <th>События</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {links.map((l) => (
                    <tr key={l.source_ip + "|" + l.deployment_id}>
                      <td>
                        <button
                          className="text-link mono"
                          onClick={() => choose("source", l.source_ip)}
                        >
                          {l.source_ip}
                        </button>
                      </td>
                      <td>
                        <Link to={`/traps/${l.deployment_id}`}>
                          {data.deployments.find(
                            (d) => d.id === l.deployment_id,
                          )?.name ?? l.deployment_id}
                        </Link>
                      </td>
                      <td>{time(l.last_seen)}</td>
                      <td>{l.event_count}</td>
                      <td>
                        <button
                          className="text-link"
                          onClick={() => openLink(l)}
                        >
                          {l.session_id ? "Плеер" : "События"}
                          <ArrowRight size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="topology-watermark">
            Снимок {time(data.until)} · связи основаны на сохранённых входящих
            наблюдениях
          </div>
        </>
      )}
    </section>
  );
}
