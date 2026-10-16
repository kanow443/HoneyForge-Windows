import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import { Empty, ErrorNotice, Loading, time } from "../../shared/ui";
const reasons: Record<string, string> = {
  not_configured: "База не подключена",
  unreadable_database: "База недоступна",
  wrong_database_type: "Неподходящий тип базы",
  private_or_reserved_address: "Локальный или зарезервированный адрес",
  database_missing_or_address_not_found: "База отсутствует или адрес не найден",
  invalid_address: "Некорректный адрес",
};
export function GeoSources({ sourceIp }: { sourceIp?: string }) {
  const [expanded, setExpanded] = useState(false);
  const q = useQuery({
    queryKey: ["geo-sources"],
    queryFn: api.geoSources,
    enabled: expanded,
    refetchInterval: expanded ? 30000 : false,
  });
  const rows = sourceIp
    ? q.data?.sources.filter((source) => source.source_ip === sourceIp)
    : q.data?.sources;
  return (
    <details
      className="technical-details geo-sources"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        {sourceIp ? "География и сеть источника" : "География источников"}
      </summary>
      {expanded && (
        <div className="panel-padding">
          <ErrorNotice error={q.error} onRetry={() => q.refetch()} />
          {q.isPending ? (
            <Loading />
          ) : (
            q.data && (
              <>
                <p className="permission-note">
                  <a
                    href="https://db-ip.com"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    DB-IP
                  </a>{" "}
                  · данные распространяются по CC BY 4.0.
                </p>
                <p className="permission-note">
                  Приблизительные сведения локальных баз. IP, страна и ASN не
                  определяют личность. Выборка: до 20 источников по времени
                  наблюдения с {time(q.data.since, true)}.
                </p>
                <div className="geo-databases">
                  {[
                    ["География", q.data.city_database],
                    ["ASN", q.data.asn_database],
                  ].map(([label, database]) => {
                    const value = database as typeof q.data.city_database;
                    return (
                      <span key={label as string}>
                        {label as string}:{" "}
                        {value.status === "available"
                          ? "база доступна"
                          : (reasons[value.reason ?? ""] ?? "база недоступна")}
                        {value.provider ? " · " + value.provider : ""}
                        {value.age_days != null
                          ? " · возраст " + value.age_days + " дн."
                          : ""}
                        {value.stale === true
                          ? " · требуется обновление базы"
                          : ""}
                        {value.built_at
                          ? " · сборка " + time(value.built_at, true)
                          : ""}
                      </span>
                    );
                  })}
                </div>
                {rows?.length ? (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Источник</th>
                          <th>Местоположение</th>
                          <th>Сеть</th>
                          <th>События</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((source) => (
                          <tr key={source.source_ip}>
                            <td className="mono">{source.source_ip}</td>
                            <td>
                              {source.country || source.city
                                ? [source.country, source.city]
                                    .filter(Boolean)
                                    .join(", ")
                                : (reasons[source.reason ?? ""] ??
                                  "Не определено")}
                              {source.accuracy_radius_km != null && (
                                <small className="cell-sub">
                                  Радиус точности {source.accuracy_radius_km} км
                                </small>
                              )}
                            </td>
                            <td>
                              {source.asn != null
                                ? "AS" + source.asn
                                : "Не определена"}
                              {source.organization && (
                                <small className="cell-sub">
                                  {source.organization}
                                </small>
                              )}
                            </td>
                            <td>{source.event_count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty
                    title="Источник отсутствует в текущей выборке"
                    description="Это не подтверждение отсутствия событий. Показаны только наиболее частые источники за 24 часа."
                  />
                )}
              </>
            )
          )}
        </div>
      )}
    </details>
  );
}
