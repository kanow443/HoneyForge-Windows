import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowDown,
  ArrowRight,
  Download,
  Pause,
  Play,
  Search,
  X,
} from "lucide-react";
import { api, downloadExport } from "../../shared/api/client";
import type { Event, EventFlag, EventPage } from "../../shared/api/models";
import {
  Code,
  Empty,
  ErrorNotice,
  KeyValue,
  Loading,
  PageHeader,
  Panel,
  time,
} from "../../shared/ui";
import { useLive } from "../../app/LiveProvider";
import { eventFilters, eventTypes, setFilter } from "./filters";
import { eventLabel, eventSummary, eventNote } from "./presentation";
import { PrivateCapture } from "../evidence/PrivateCapture";
import { ArtifactReference } from "../evidence/ArtifactReference";
import { PermissionNote, usePermissions } from "../auth/permissions";
import { ObservableExport } from "../analysis/ObservableExport";
import { DetectionPolicy } from "../analysis/DetectionPolicy";
import {
  Collapse,
  useContentMotion,
  useExitValue,
} from "../../shared/ui/motion";
export function EventsPage() {
  const { can } = usePermissions();
  const [params, setParams] = useSearchParams(),
    [paused, setPaused] = useState(false),
    [display, setDisplay] = useState<EventPage | null>(null),
    [selected, setSelected] = useState<Event | null>(null),
    [exporting, setExporting] = useState(false),
    [error, setError] = useState<unknown>(null),
    [advanced, setAdvanced] = useState(() =>
      ["host_id", "source_ip", "flag", "since", "until"].some((k) => params.has(k)),
    );
  const detail = useExitValue(selected);
  const detailMotion = useContentMotion<HTMLElement>(detail?.id);
  const filters = eventFilters(params),
    filterKey = JSON.stringify(filters),
    lastFilter = useRef(filterKey);
  const q = useQuery({
    queryKey: ["events", filters],
    queryFn: ({ signal }) => api.events(filters, signal),
    staleTime: 10000,
  });
  const hosts = useQuery({ queryKey: ["hosts"], queryFn: api.hosts }),
    traps = useQuery({ queryKey: ["deployments"], queryFn: api.deployments });
  const { reset, status } = useLive();
  const initialReset = useRef(reset);
  useEffect(() => {
    if (lastFilter.current !== filterKey) {
      lastFilter.current = filterKey;
      setDisplay(null);
      setSelected(null);
    }
  }, [filterKey]);
  useEffect(() => {
    if (q.data) {
      setDisplay((current) => (paused ? (current ?? q.data) : q.data));
      const selectedId = params.get("event");
      if (selectedId)
        setSelected((current) =>
          current?.id === selectedId
            ? current
            : (q.data.items.find((e) => e.id === selectedId) ?? null),
        );
    }
  }, [q.data, params, paused]);
  useEffect(() => {
    if (reset !== initialReset.current) {
      initialReset.current = reset;
      if (!paused) setDisplay(null);
    }
  }, [reset, paused]);
  const rows = display?.items ?? [],
    newCount =
      q.data && display
        ? q.data.items.filter((e) => !rows.some((r) => r.id === e.id)).length
        : 0;
  function filter(k: string, v: string) {
    setPaused(false);
    setParams(setFilter(params, k, v), { replace: true });
  }
  async function exportData() {
    setExporting(true);
    setError(null);
    try {
      await downloadExport({ filters });
    } catch (e) {
      setError(e);
    } finally {
      setExporting(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="НАБЛЮДЕНИЕ"
        title="Журнал событий"
        description="Журнал телеметрии HTTP и SSH. Выберите запись для разбора."
        action={
          <>
            <details className="export-menu">
              <summary className="button">Экспорт</summary>
              <div className="export-options">
                <button
                  className="button"
                  disabled={exporting || !can("investigate")}
                  onClick={exportData}
                >
                  <Download size={16} />
                  {exporting ? "Экспортируем…" : "JSON событий"}
                </button>
                <ObservableExport filters={filters} />
              </div>
            </details>
            <button
              className={`button ${paused ? "primary" : ""}`}
              onClick={() => {
                setPaused((v) => !v);
                if (paused) {
                  setDisplay(q.data ?? null);
                  void q.refetch().then((result) => {
                    if (result.data) setDisplay(result.data);
                  });
                }
              }}
            >
              {paused ? <Play size={15} /> : <Pause size={15} />}{" "}
              {paused ? "Продолжить" : "Пауза"}
            </button>
          </>
        }
      />
      <PermissionNote permission="investigate" />
      <DetectionPolicy />
      <div className="events-live-row">
        <span className="muted">
          {paused
            ? "Отображение на паузе; агент продолжает сбор."
            : status === "connected"
              ? "Обновление включено"
              : status === "offline"
                ? "Нет связи с сервером"
                : "Подключаемся к серверу…"}
        </span>
        {reset > 0 && <span className="chip">Snapshot обновлён</span>}
      </div>
      <div className="event-query-bar">
        <div className="search-field">
          <Search size={16} />
          <input
            aria-label="Поиск событий"
            maxLength={200}
            placeholder="Команда, путь, payload…"
            value={params.get("q") ?? ""}
            onChange={(e) => filter("q", e.target.value)}
          />
        </div>

        <select
          aria-label="Фильтр по ловушке"
          value={params.get("deployment_id") ?? ""}
          onChange={(e) => filter("deployment_id", e.target.value)}
        >
          <option value="">Все ловушки</option>
          {traps.data?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Тип события"
          value={params.get("event_type") ?? ""}
          onChange={(e) => filter("event_type", e.target.value)}
        >
          <option value="">Все типы</option>
          {eventTypes.map((t) => (
            <option key={t} value={t}>
              {eventLabel(t)}
            </option>
          ))}
        </select>
        <button
          className={`button ${advanced ? "active" : ""}`}
          aria-expanded={advanced}
          aria-controls="advanced-filters"
          onClick={() => setAdvanced((v) => !v)}
        >
          Уточнить поиск
        </button>
        <button
          className="button small"
          onClick={() => {
            setParams({});
            setPaused(false);
          }}
        >
          Сбросить
        </button>
      </div>
      <Collapse open={advanced} id="advanced-filters">
        <div className="advanced-filter-grid">
          <select aria-label="Фильтр по флагу" value={params.get("flag") ?? ""} onChange={(e) => filter("flag", e.target.value)}>
            <option value="">Все пометки</option>
            {Object.entries(flagLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select
            aria-label="Фильтр по хосту"
            value={params.get("host_id") ?? ""}
            onChange={(e) => filter("host_id", e.target.value)}
          >
            <option value="">Все хосты</option>
            {hosts.data?.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>{" "}
          <input
            aria-label="IP источника"
            placeholder="IP источника"
            maxLength={80}
            value={params.get("source_ip") ?? ""}
            onChange={(e) => filter("source_ip", e.target.value)}
          />
          <label className="date-filter">
            С
            <input
              type="datetime-local"
              aria-label="События с"
              value={params.get("since") ? localDate(params.get("since")!) : ""}
              onChange={(e) =>
                filter(
                  "since",
                  e.target.value ? new Date(e.target.value).toISOString() : "",
                )
              }
            />
          </label>
          <label className="date-filter">
            По
            <input
              type="datetime-local"
              aria-label="События по"
              value={params.get("until") ? localDate(params.get("until")!) : ""}
              onChange={(e) =>
                filter(
                  "until",
                  e.target.value ? new Date(e.target.value).toISOString() : "",
                )
              }
            />
          </label>
        </div>
      </Collapse>
      <ErrorNotice error={q.error || error} onRetry={() => q.refetch()} />
      {newCount > 0 && paused && (
        <button
          className="new-events"
          onClick={() => setDisplay(q.data ?? null)}
        >
          <ArrowDown size={15} />
          {newCount} новых записей — показать
        </button>
      )}
      <div className={`event-workspace ${detail ? "with-detail" : ""}`}>
        <Panel className="event-list" motionKey={`${filterKey}:${q.isPending}`}>
          <div className="panel-heading">
            <h2>Журнал наблюдений</h2>
            <span className="muted">
              {display?.total ?? q.data?.total ?? 0} событий, по времени приёма
            </span>
          </div>
          {q.isPending && !display ? (
            <Loading />
          ) : rows.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Получено</th>
                    <th>Источник</th>
                    <th>Событие</th>
                    <th className="secondary-column">Ловушка</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((e) => (
                    <tr
                      key={e.id}
                      className={params.get("event") === e.id ? "selected" : ""}
                    >
                      <td className="mono muted">{time(e.created_at)}</td>
                      <td className="mono">{e.source_ip}</td>
                      <td>
                        <button
                          className="event-open"
                          onClick={() => {
                            setSelected(e);
                            setParams(setFilter(params, "event", e.id), {
                              replace: true,
                            });
                          }}
                        >
                          <span
                            className={`event-type ${e.event_type.includes("failed") ? "bad" : ""}`}
                          >
                            {eventLabel(e.event_type)}
                          </span>
                          <span className="event-summary mono">
                            {eventSummary(e)}
                          </span>
                          {e.flags?.map((mark) => <span key={mark.id} className="chip">{flagLabels[mark.flag]}</span>)}
                        </button>
                      </td>
                      <td className="secondary-column">
                        <Link to={`/traps/${e.deployment_id}`}>
                          {e.deployment_name}
                        </Link>
                      </td>
                      <td>
                        <button
                          className="icon-button"
                          aria-label={`Открыть событие ${e.event_id}`}
                          onClick={() => {
                            setSelected(e);
                            setParams(setFilter(params, "event", e.id), {
                              replace: true,
                            });
                          }}
                        >
                          <ArrowRight size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            !q.error && (
              <Empty
                title="Событий в выборке пока нет"
                description={
                  Object.keys(filters).length > 2
                    ? "Измените фильтры или период. События фильтруются по времени приёма сервером."
                    : "Подключитесь к работающей ловушке с учебного клиента. Сохранённые наблюдения появятся здесь."
                }
                action={
                  <Link className="button" to="/traps">
                    Открыть ловушки
                  </Link>
                }
              />
            )
          )}
          <div className="pagination">
            <span>
              {display?.total
                ? `${filters.offset! + 1}–${Math.min(filters.offset! + rows.length, display.total)} из ${display.total}`
                : "0 событий"}
            </span>
            <div>
              <button
                className="button small"
                disabled={!filters.offset}
                onClick={() => {
                  const p = new URLSearchParams(params);
                  p.set("offset", String(Math.max(0, filters.offset! - 100)));
                  setParams(p);
                  setPaused(false);
                }}
              >
                Назад
              </button>
              <button
                className="button small"
                disabled={!display || filters.offset! + 100 >= display.total}
                onClick={() => {
                  const p = new URLSearchParams(params);
                  p.set("offset", String(filters.offset! + 100));
                  setParams(p);
                  setPaused(false);
                }}
              >
                Далее
              </button>
            </div>
          </div>
        </Panel>
        {detail && (
          <aside
            ref={detailMotion}
            className={`event-detail ${selected ? "" : "motion-leave"}`}
            inert={!selected}
            aria-hidden={!selected}
          >
            <div className="panel-heading">
              <h2>Детали события</h2>
              <button
                className="icon-button"
                aria-label="Закрыть событие"
                onClick={() => {
                  setSelected(null);
                  setParams(setFilter(params, "event", ""), { replace: true });
                }}
              >
                <X size={18} />
              </button>
            </div>
            <div className="detail-body">
              <span className="event-detail-type">
                {eventLabel(detail.event_type)}
              </span>
              <h3 className="mono">{detail.source_ip}</h3>
              <KeyValue label="Наблюдалось">
                {time(detail.observed_at, true)}
              </KeyValue>
              <KeyValue label="Получено">
                {time(detail.created_at, true)}
              </KeyValue>
              <KeyValue label="Получено от">
                {detail.provenance === "lab-fixture" ? (
                  <span className="warn">Учебный fixture</span>
                ) : (
                  detail.provenance
                )}
              </KeyValue>
              <KeyValue label="Ловушка">
                <Link to={`/traps/${detail.deployment_id}`}>
                  {detail.deployment_name}
                </Link>
              </KeyValue>
              <h3>Содержимое события</h3>
              <Code value={detail.payload} />
              <EventFlags event={detail} editable={can("investigate")} onUpdate={setSelected} />
              {eventNote(detail.event_type) && (
                <p className="panel-note">{eventNote(detail.event_type)}</p>
              )}
              <ArtifactReference event={detail} />
              {selected && <PrivateCapture key={detail.id} event={detail} />}
              {detail.event_type === "ssh.command" && (
                <p className="panel-note">
                  Команды Cowrie отражают действия в эмуляторе. wget/curl
                  показывают намерение, а не подтверждённое сетевое соединение.
                </p>
              )}
              {detail.session_id ? (
                <Link
                  className="button primary wide"
                  to={`/sessions/${detail.session_id}`}
                >
                  Разобрать сессию
                  <ArrowRight size={15} />
                </Link>
              ) : (
                <p className="muted">Событие не связано с сессией.</p>
              )}
              <details className="technical-details">
                <summary>Технические данные</summary>
                <KeyValue label="Тип события">
                  <code>{detail.event_type}</code>
                </KeyValue>
                <KeyValue label="Event ID">
                  <code className="break-all">{detail.event_id}</code>
                </KeyValue>
                <KeyValue label="Evidence ID">
                  <code className="break-all">{detail.id}</code>
                </KeyValue>
                <KeyValue label="Profile version">
                  <code className="break-all">{detail.profile_version_id}</code>
                </KeyValue>
                <KeyValue label="Runtime generation">
                  <code className="break-all">{detail.generation}</code>
                </KeyValue>
              </details>
            </div>
          </aside>
        )}
      </div>
    </>
  );
}

const flagLabels: Record<EventFlag["flag"], string> = {
  suspicious: "Подозрительно",
  reviewed: "Проверено",
  false_positive: "Ложное срабатывание",
  escalated: "Передано на разбор",
};
function EventFlags({ event, editable, onUpdate }: { event: Event; editable: boolean; onUpdate: (event: Event) => void }) {
  const client = useQueryClient();
  const [flag, setFlag] = useState<EventFlag["flag"]>("suspicious");
  const [note, setNote] = useState("");
  const mutation = useMutation({
    mutationFn: (entry: { flag: EventFlag["flag"]; enabled: boolean; note: string }) => api.setEventFlag(event.id, entry),
    onSuccess: (updated) => {
      onUpdate(updated);
      setNote("");
      void client.invalidateQueries({ queryKey: ["events"] });
    },
  });
  return <section>
    <h3>Флаги анализа</h3>
    {!event.flags?.length && <p className="muted">Пометок пока нет.</p>}
    {event.flags?.map((entry) => <p key={entry.id} className="panel-note">
      <strong>{flagLabels[entry.flag]}</strong>{entry.note ? ` — ${entry.note}` : ""} · {entry.created_by}
      {editable && <button className="button small" disabled={mutation.isPending} onClick={() => mutation.mutate({ flag: entry.flag, enabled: false, note: "" })}>Снять</button>}
    </p>)}
    {editable && <form onSubmit={(e) => { e.preventDefault(); mutation.mutate({ flag, enabled: true, note: note.trim() }); }}>
      <select aria-label="Флаг события" value={flag} onChange={(e) => setFlag(e.target.value as EventFlag["flag"])}>
        {Object.entries(flagLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <input aria-label="Комментарий к флагу" placeholder="Короткое пояснение" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      <button className="button" disabled={mutation.isPending}>Добавить пометку</button>
    </form>}
    <ErrorNotice error={mutation.error} />
  </section>;
}
function localDate(s: string) {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
