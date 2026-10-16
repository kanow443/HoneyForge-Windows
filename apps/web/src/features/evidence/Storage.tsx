import { useQuery } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import {
  Empty,
  ErrorNotice,
  KeyValue,
  Loading,
  PageHeader,
  Panel,
} from "../../shared/ui";
import { byteSize } from "./download";
export function StoragePage() {
  const q = useQuery({
    queryKey: ["storage"],
    queryFn: api.storage,
    refetchInterval: 30000,
  });
  return (
    <>
      <PageHeader
        title="Хранилище"
        description="Сроки хранения, резерв под артефакты и закреплённые расследования."
        action={
          <button
            className="button"
            disabled={q.isFetching}
            onClick={() => q.refetch()}
          >
            Обновить
          </button>
        }
      />
      <ErrorNotice error={q.error} onRetry={() => q.refetch()} />
      {q.isPending ? (
        <Loading />
      ) : q.data ? (
        <Panel title="Состояние хранения">
          <div className="detail-grid">
            <KeyValue label="События">
              {q.data.event_retention_days} дней
            </KeyValue>
            <KeyValue label="Журнал оператора">
              {q.data.audit_retention_days} дней
            </KeyValue>
            <KeyValue label="Зарезервировано">
              {byteSize(q.data.reserved_bytes)} из{" "}
              {byteSize(q.data.quota_bytes)}
            </KeyValue>
            <KeyValue label="Закреплённые дела">{q.data.pinned_cases}</KeyValue>
          </div>
          <div className="panel-padding">
            <p className="permission-note">
              {q.data.collection_available
                ? "Есть место для приёма артефактов."
                : "Приём новых артефактов недоступен: лимит хранения исчерпан."}{" "}
              Это состояние хранилища, а не подтверждение работы сенсора.
            </p>
            <p className="permission-note">
              Закрепление дела защищает связанные сессии и доказательства от
              плановой очистки. После снятия закрепления снова действует обычный
              срок хранения; удалённое содержимое не восстанавливается.
            </p>
          </div>
        </Panel>
      ) : !q.error ? (
        <Empty
          title="Данные о хранилище не получены"
          description="Обновите страницу после восстановления связи."
        />
      ) : null}
    </>
  );
}
