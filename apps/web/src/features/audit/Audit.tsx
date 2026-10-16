import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../shared/api/client";
import {
  Code,
  Empty,
  ErrorNotice,
  Loading,
  PageHeader,
  Panel,
  time,
} from "../../shared/ui";
const actions: Record<string, string> = {
  "honeytoken.issued": "Выпущен маркер-приманка",
  "honeytoken.revoked": "Отозван маркер-приманка",
  "detection.updated": "Изменено правило повторных входов",
  "ioc.exported": "Подготовлен экспорт наблюдений",
  "certificate.issued": "Выпущен сертификат агента",
  "certificate.confirmed": "Агент подтвердил сертификат",
  "certificate.revoked": "Отозван сертификат агента",
  "profile.metadata_updated": "Изменены сведения профиля",
  "profile.archived": "Профиль архивирован",
  "profile.restored": "Профиль восстановлен",
  "profile.deleted": "Профиль удалён",
  "profile.created": "Создан профиль",
  "profile.version_published": "Опубликована версия",
  "profile.version.published": "Опубликована версия",
  "profile.versioned": "Опубликована версия",
  "deployment.requested": "Запрошено развёртывание",
  "deployment.created": "Создана ловушка",
  "deployment.stopped": "Запрошена остановка",
  "deployment.stop.requested": "Запрошена остановка",
  "deployment.redeployed": "Повторное развёртывание",
  "host.enrollment_token.created": "Выпущен токен подключения",
  "host.revoked": "Отозван хост",
  "events.exported": "Экспорт событий",
  "artifact.downloaded": "Запрошено скачивание доказательства",
  "user.created": "Создан пользователь",
  "user.role_changed": "Изменена роль пользователя",
  "integration.created": "Создан ключ интеграции",
  "integration.revoked": "Отозван ключ интеграции",
  "integration.read": "Запрошены события через интеграцию",
  "source.block.requested": "Запрошено ограничение источника",
  "source.block.cancelled": "Запрошена отмена ограничения",
  "source.block.applied": "Агент применил ограничение",
  "source.block.released": "Агент снял ограничение",
  "source.block.error": "Ошибка применения ограничения",
  "case.created": "Создано дело",
  "case.retention_changed": "Изменено закрепление доказательств",
  "private_capture.revealed": "Раскрыты закрытые данные события",
  "case.updated": "Обновлено дело",
};
export function AuditPage() {
  const q = useQuery({
    queryKey: ["audit"],
    queryFn: api.audit,
    refetchInterval: 15000,
  });
  return (
    <>
      <PageHeader
        title="Журнал оператора"
        description="Сохранённые действия управления. Только чтение; последние 200 записей."
      />
      <ErrorNotice error={q.error} onRetry={() => q.refetch()} />
      <Panel motionKey={q.isPending}>
        {q.isPending ? (
          <Loading />
        ) : q.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Время</th>
                  <th>Оператор</th>
                  <th>Действие</th>
                  <th>Объект</th>
                  <th>Детали</th>
                </tr>
              </thead>
              <tbody>
                {q.data.map((a) => {
                  const route = a.action.startsWith("profile.")
                    ? "/profiles/"
                    : a.action.startsWith("deployment.")
                      ? "/traps/"
                      : a.action === "host.revoked"
                        ? "/hosts?host="
                        : a.action.startsWith("case.")
                          ? "/cases?case="
                          : null;
                  return (
                    <tr key={a.id}>
                      <td className="mono muted">{time(a.created_at)}</td>
                      <td>{a.actor}</td>
                      <td>
                        {actions[a.action] ?? a.action}
                        <small className="cell-sub mono">{a.action}</small>
                      </td>
                      <td className="mono">
                        {route && /^[\da-f-]{36}$/.test(a.object_id) ? (
                          <Link to={`${route}${a.object_id}`}>
                            {a.object_id.slice(0, 8)}…
                          </Link>
                        ) : (
                          a.object_id
                        )}
                      </td>
                      <td>
                        <details>
                          <summary>Запись сохранена</summary>
                          <Code value={a.details} />
                        </details>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          !q.error && (
            <Empty
              title="История действий пока пуста"
              description="Публикации профилей, задания, подключения и экспорт будут отражены здесь."
            />
          )
        )}
      </Panel>
    </>
  );
}
