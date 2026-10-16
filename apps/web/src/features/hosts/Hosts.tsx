import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Plus, Server, ShieldOff } from "lucide-react";
import { api } from "../../shared/api/client";
import type { Host } from "../../shared/api/models";
import { useExitValue } from "../../shared/ui/motion";
import { PermissionNote, usePermissions } from "../auth/permissions";
import { adapterLabel } from "../profiles/config";
import { HostCertificates } from "./HostCertificates";
import {
  Code,
  CopyButton,
  Empty,
  ErrorNotice,
  Loading,
  Modal,
  PageHeader,
  Panel,
  Status,
  age,
  time,
  KeyValue,
} from "../../shared/ui";
export function HostsPage() {
  const { can } = usePermissions();
  const query = useQuery({
      queryKey: ["hosts"],
      queryFn: api.hosts,
      refetchInterval: 15000,
    }),
    client = useQueryClient();
  const [params, setParams] = useSearchParams(),
    [enroll, setEnroll] = useState(false),
    [revoke, setRevoke] = useState<Host | null>(null),
    [clock, setClock] = useState(Date.now());
  const token = useMutation({ mutationFn: api.enrollment });
  const revocation = useMutation({
    mutationFn: (id: string) => api.revoke(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["hosts"] });
      setRevoke(null);
    },
  });
  useEffect(() => {
    if (!enroll) return;
    const t = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(t);
  }, [enroll]);
  const selected = query.data?.find((h) => h.id === params.get("host"));
  const detail = useExitValue(selected);
  function metricTotal(key: "queued_events" | "dropped_events") {
    if (!query.data || query.data.some((host) => host.metrics[key] == null))
      return "—";
    return query.data.reduce((sum, host) => sum + host.metrics[key]!, 0);
  }
  const expired = !!token.data && Date.parse(token.data.expires_at) <= clock;
  function close() {
    setEnroll(false);
    token.reset();
  }
  return (
    <>
      <PageHeader
        eyebrow="ИНФРАСТРУКТУРА"
        title="Хосты"
        description="Доступность агентов, ресурсы и состояние доставки событий."
        action={
          <button
            className="button primary"
            disabled={!can("admin")}
            onClick={() => {
              setEnroll(true);
              token.reset();
            }}
          >
            <Plus size={17} />
            Подключить хост
          </button>
        }
      />
      <PermissionNote permission="admin" />
      <div className="fleet-readout">
        <span>
          <b>{query.data?.length ?? "—"}</b> подключено
        </span>
        <span className="good">
          <b>
            {query.data?.filter((h) => h.status === "online").length ?? "—"}
          </b>{" "}
          на связи
        </span>
        <span>
          <b>{metricTotal("queued_events")}</b> событий в очереди
        </span>
        <span>
          <b>{metricTotal("dropped_events")}</b> отброшено
        </span>
      </div>
      <ErrorNotice error={query.error} onRetry={() => query.refetch()} />
      {query.isPending ? (
        <Loading />
      ) : query.data?.length ? (
        <Panel>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Хост</th>
                  <th>Состояние</th>
                  <th>Heartbeat</th>
                  <th>Ресурсы</th>
                  <th>Доставка событий</th>
                  <th>Адаптеры</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {query.data.map((h) => (
                  <tr
                    key={h.id}
                    className={h.id === selected?.id ? "selected" : ""}
                  >
                    <td>
                      <button
                        className="entity-link"
                        onClick={() => setParams({ host: h.id })}
                      >
                        <Server size={16} />
                        {h.name}
                        <small className="mono">{h.address}</small>
                      </button>
                    </td>
                    <td>
                      <Status value={h.status} />
                    </td>
                    <td className="mono muted">{age(h.last_seen)}</td>
                    <td className="mono">
                      <span>CPU {h.metrics.cpu_percent ?? "—"}%</span>
                      <small className="cell-sub">
                        RAM {h.metrics.memory_percent ?? "—"}%
                      </small>
                    </td>
                    <td className="mono">
                      <span>В очереди {h.metrics.queued_events ?? "—"}</span>
                      <small
                        className={`cell-sub ${h.metrics.dropped_events ? "bad" : ""}`}
                      >
                        Потери {h.metrics.dropped_events ?? "—"}
                      </small>
                    </td>
                    <td>
                      {h.capabilities.map((c) => (
                        <span className="chip" key={c}>
                          {adapterLabel(c)}
                        </span>
                      ))}
                    </td>
                    <td>
                      <button
                        className="icon-button"
                        disabled={h.status === "revoked" || !can("admin")}
                        aria-label={`Отозвать ${h.name}`}
                        onClick={() => {
                          revocation.reset();
                          setRevoke(h);
                        }}
                      >
                        <ShieldOff size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : (
        !query.error && (
          <Panel>
            <Empty
              title="Подключите первый sensor host"
              description="Агент запускается на вашем Linux-хосте, получает задания и надёжно отправляет телеметрию. Для регистрации нужен одноразовый токен."
              action={
                <button
                  className="button primary"
                  disabled={!can("admin")}
                  onClick={() => setEnroll(true)}
                >
                  <Plus size={16} />
                  Подключить хост
                </button>
              }
            />
          </Panel>
        )
      )}
      {detail && (
        <Panel
          title={detail.name}
          motionKey={detail.id}
          className={selected ? "host-detail" : "host-detail motion-leave"}
          inert={!selected}
          aria-hidden={!selected}
          action={
            <button className="button small" onClick={() => setParams({})}>
              Закрыть
            </button>
          }
        >
          <div className="detail-grid">
            <KeyValue label="Host ID">
              <span className="mono">{detail.id}</span>
            </KeyValue>
            <KeyValue label="Runtime">
              {detail.runtime_version || "Не передан"}
            </KeyValue>
            <KeyValue label="Последний heartbeat">
              {time(detail.last_seen, true)}
            </KeyValue>
            <KeyValue label="Ошибки парсера">
              {detail.metrics.parser_errors ?? "Не передано"}
            </KeyValue>
            <KeyValue label="Сетевая политика">
              {detail.metrics.network_policy ?? "unverified"}
            </KeyValue>
            <KeyValue label="Отозван">{time(detail.revoked_at, true)}</KeyValue>
          </div>
          <div className="panel-padding">
            <Link className="button" to={`/events?host_id=${detail.id}`}>
              События этого хоста
            </Link>
            <HostCertificates key={detail.id} hostId={detail.id} />
          </div>
        </Panel>
      )}
      <Modal
        open={enroll && can("admin")}
        onClose={close}
        title="Подключение sensor host"
        description="Одноразовый токен действует 10 минут. Передайте его только своему агенту."
      >
        {!token.data ? (
          <>
            <div className="info-note">
              Подготовьте отдельный Linux-хост с Docker и установленным
              HoneyForge Agent. Управляющая панель и атакуемые сервисы должны
              находиться в разных сетевых контурах.
            </div>
            <ErrorNotice error={token.error} />
            <button
              className="button primary wide"
              disabled={token.isPending}
              onClick={() => token.mutate()}
            >
              {token.isPending ? "Выпускаем…" : "Получить одноразовый токен"}
            </button>
          </>
        ) : (
          <>
            <div className={`info-note ${expired ? "bad" : ""}`}>
              {expired
                ? "Токен истёк. Получите новый."
                : `Действует до ${time(token.data.expires_at, true)}, ${Math.max(0, Math.ceil((Date.parse(token.data.expires_at) - clock) / 60000))} мин`}
            </div>
            <div className="token-box">
              <code>{token.data.token}</code>
              <CopyButton value={token.data.token} />
            </div>
            <h3>На вашем Linux-хосте</h3>
            <p className="muted">
              Укажите доступный с хоста адрес API (порт 8100), имя и адрес
              сенсора. Сохраните токен в защищённом файле на sensor host.
            </p>
            <Code
              value={
                "uv run hf-agent --help\nHF_AGENT_API=http://<control-host>:8100 HF_AGENT_NAME=sensor-01 HF_AGENT_ADDRESS=<sensor-ip> uv run hf-agent enroll --token-file /secure/path/enrollment-token\nHF_AGENT_API=http://<control-host>:8100 uv run hf-agent run"
              }
            />
            <p className="muted">
              Проверьте параметры установленной версии через <code>--help</code>
              . После регистрации хост появится в списке по heartbeat.
            </p>
            <ErrorNotice error={token.error} />
            {expired && (
              <button
                className="button primary"
                disabled={token.isPending}
                onClick={() => token.mutate()}
              >
                Выпустить новый токен
              </button>
            )}
          </>
        )}
      </Modal>
      <Modal
        open={!!revoke && can("admin")}
        onClose={() => setRevoke(null)}
        title="Отозвать доступ хоста?"
        description={`Хост «${revoke?.name ?? ""}» перестанет получать задания и передавать данные. Это НЕ физическая остановка ловушек.`}
      >
        <div className="info-note">
          Сначала остановите активные ловушки, если агент ещё доступен. После
          отзыва фактическое состояние runtime может быть неизвестно. История
          сохраняется.
        </div>
        <ErrorNotice error={revocation.error} />
        <div className="actions">
          <button className="button" onClick={() => setRevoke(null)}>
            Отмена
          </button>
          <button
            className="button danger"
            disabled={revocation.isPending}
            onClick={() => revoke && revocation.mutate(revoke.id)}
          >
            {revocation.isPending ? "Отзываем…" : "Отозвать доступ"}
          </button>
        </div>
      </Modal>
    </>
  );
}
