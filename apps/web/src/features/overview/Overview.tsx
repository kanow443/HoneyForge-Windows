import { lazy, Suspense } from "react";
import { TopologyPanel } from "./Topology";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ArrowRight, Plus, Server, ShieldAlert } from "lucide-react";
import { adapterLabel } from "../profiles/config";
import { api } from "../../shared/api/client";
import { usePermissions } from "../auth/permissions";
import {
  Empty,
  ErrorNotice,
  Loading,
  PageHeader,
  Panel,
  Status,
  age,
  time,
} from "../../shared/ui";
const GeoSources = lazy(() =>
  import("../analysis/GeoSources").then((m) => ({ default: m.GeoSources })),
);
import { FindingTime } from "../analysis/FindingTime";
export function OverviewPage() {
  const { can } = usePermissions();
  const query = useQuery({
    queryKey: ["overview"],
    queryFn: api.overview,
    refetchInterval: 15000,
  });
  const findings = useQuery({ queryKey: ["findings"], queryFn: api.findings });
  if (query.isPending) return <Loading />;
  if (query.error)
    return <ErrorNotice error={query.error} onRetry={() => query.refetch()} />;
  const d = query.data,
    max = Math.max(1, ...d.histogram.map((x) => x.count));
  return (
    <>
      <PageHeader
        eyebrow=""
        title="Сеть ловушек"
        description="Состояние инфраструктуры и наблюдения за 24 часа."
        action={
          can("operate") && (
            <Link className="button primary" to="/traps/new">
              <Plus size={16} />
              Развернуть ловушку
            </Link>
          )
        }
      />
      <div className="network-summary">
        <div>
          <span>Работают</span>
          <strong>
            {d.running_traps}
            <small>из {d.total_traps}</small>
          </strong>
          <span>ловушек</span>
        </div>
        <div>
          <span>На связи</span>
          <strong>
            {d.online_hosts}
            <small>из {d.total_hosts}</small>
          </strong>
          <span>хостов</span>
        </div>
        <div>
          <span>За 24 часа</span>
          <strong>{d.events_24h.toLocaleString("ru-RU")}</strong>
          <span>событий</span>
        </div>
        <div>
          <span>Источники</span>
          <strong>{d.unique_sources}</strong>
          <span>уникальных IP</span>
        </div>
        <div className="summary-period">
          <span>Последний срез</span>
          <code>{time(d.server_time)}</code>
          <span>Обновление каждые 15 с</span>
        </div>
      </div>
      <TopologyPanel />
      <div className="network-workspace">
        <div className="network-main">
          <Panel
            title="Развёртывания"
            action={
              <Link className="text-link" to="/traps">
                Все {d.total_traps}
                <ArrowRight size={14} />
              </Link>
            }
          >
            {d.deployments.length ? (
              <div className="deployment-register">
                <div className="register-heading">
                  <span>Ловушка</span>
                  <span>Состояние</span>
                  <span>Активность</span>
                </div>
                {d.deployments.slice(0, 6).map((t) => (
                  <Link
                    to={`/traps/${t.id}`}
                    className="deployment-register-row"
                    key={t.id}
                  >
                    <div className="register-identity">
                      <strong>{t.name}</strong>
                      <code>{t.endpoint}</code>
                      <small>
                        {adapterLabel(t.adapter)}. {t.profile_name}. Версия{" "}
                        {t.version_number}
                      </small>
                    </div>
                    <Status value={t.state} />
                    <div className="register-count">
                      <strong>{t.event_count}</strong>
                      <small>событий</small>
                    </div>
                    <ArrowRight size={16} />
                  </Link>
                ))}
              </div>
            ) : (
              <Empty
                title="Сеть готова к первому запуску"
                description="Подключите хост, опубликуйте профиль и примените его на свободном порту."
                action={
                  <div className="actions">
                    <Link className="button" to="/hosts">
                      {can("admin") ? "Подключить хост" : "Хосты"}
                    </Link>
                    {can("operate") && (
                      <Link className="button primary" to="/profiles/new">
                        Создать профиль
                      </Link>
                    )}
                  </div>
                }
              />
            )}
          </Panel>
          <Panel
            title="Входящая активность"
            className="activity-panel"
            action={
              <Link className="text-link" to="/events">
                Расследовать события
                <ArrowRight size={14} />
              </Link>
            }
          >
            <div className="activity-meta">
              <span>
                <b>{d.events_24h.toLocaleString("ru-RU")}</b> наблюдений
              </span>
              <span>Последние 24 часа, по времени приёма</span>
            </div>
            <div
              className="histogram"
              role="img"
              aria-label={`События за последние 24 часа: ${d.events_24h}`}
            >
              <div className="chart-lines">
                <span>{max}</span>
                <span>{Math.round(max / 2)}</span>
                <span>0</span>
              </div>
              <div className="bars">
                {d.histogram.map((h) => (
                  <div
                    key={h.at}
                    title={`${time(h.at)}, ${h.count} событий`}
                    style={{ height: `${(h.count / max) * 100}%` }}
                  />
                ))}
              </div>
              {d.events_24h === 0 && (
                <div className="chart-empty">Наблюдений пока нет</div>
              )}
            </div>
            <div className="chart-axis">
              {d.histogram
                .filter((_, i) => i % 6 === 0 || i === 23)
                .map((h) => (
                  <span key={h.at}>
                    {new Date(h.at).toLocaleTimeString("ru-RU", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                ))}
            </div>
          </Panel>
        </div>
        <aside className="network-aside">
          <section className="infrastructure-section">
            <div className="section-heading">
              <h2>Инфраструктура</h2>
              <Link to="/hosts" className="text-link">
                Хосты
                <ArrowRight size={13} />
              </Link>
            </div>
            {d.hosts.length ? (
              d.hosts.slice(0, 4).map((h) => (
                <Link
                  className="infrastructure-host"
                  to={`/hosts?host=${h.id}`}
                  key={h.id}
                >
                  <div className="host-heading">
                    <Server size={16} />
                    <strong>{h.name}</strong>
                    <Status value={h.status} />
                  </div>
                  <code>{h.address}</code>
                  <div className="host-resource">
                    <span>
                      CPU <b>{h.metrics.cpu_percent ?? "—"}%</b>
                    </span>
                    <span>
                      RAM <b>{h.metrics.memory_percent ?? "—"}%</b>
                    </span>
                    <small>{age(h.last_seen)}</small>
                  </div>
                </Link>
              ))
            ) : (
              <p className="quiet-empty">Хосты ещё не подключены.</p>
            )}
            <div className="delivery-readout">
              <h3>Доставка телеметрии</h3>
              <div>
                <span>В очереди</span>
                <code>{d.queued_events}</code>
              </div>
              <div>
                <span>Отброшено агентами</span>
                <code className={d.dropped_events ? "bad" : ""}>
                  {d.dropped_events}
                </code>
              </div>
              <small>Из последнего heartbeat агента</small>
            </div>
          </section>
          <section className="rule-section">
            <div className="section-heading">
              <h2>Срабатывания правил</h2>
              <span className="section-count">
                {d.findings_24h}
                <small>за 24 часа</small>
              </span>
            </div>
            <ErrorNotice error={findings.error} />
            {findings.data?.length ? (
              <div className="rule-feed">
                {findings.data.slice(0, 4).map((f) => (
                  <Link
                    key={f.id}
                    to={
                      f.session_id
                        ? `/sessions/${f.session_id}?finding=${f.id}`
                        : `/events?deployment_id=${f.deployment_id}`
                    }
                  >
                    <div className="rule-feed-meta">
                      <ShieldAlert size={14} />
                      <span>
                        {{
                          high: "Высокая важность",
                          medium: "Средняя важность",
                          low: "Низкая важность",
                        }[f.severity] ?? f.severity}
                      </span>
                      <time>{time(f.created_at)}</time>
                    </div>
                    <h3>{f.title}</h3>
                    <FindingTime finding={f} />
                    <p>{f.deployment_name}</p>
                    <small>
                      {f.observation === "intent"
                        ? "Намерение в эмуляторе"
                        : "Наблюдаемое действие"}
                      , {f.evidence_ids.length} свидетельств
                      <ArrowRight size={13} />
                    </small>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="rule-feed-empty">
                <ShieldAlert size={19} />
                <p>Срабатываний пока нет</p>
                <small>
                  Правила связывают наблюдения с конкретными событиями.
                </small>
              </div>
            )}
          </section>
        </aside>
      </div>
      <Suspense fallback={<Loading />}>
        <GeoSources />
      </Suspense>
    </>
  );
}
