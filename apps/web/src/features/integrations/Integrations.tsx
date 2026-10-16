import { useRef, useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Plus, RefreshCw } from "lucide-react";
import { api } from "../../shared/api/client";
import type { IntegrationToken } from "../../shared/api/models";
import type { components } from "../../shared/api/generated";
import { PermissionNote, usePermissions } from "../auth/permissions";
import {
  CopyButton,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  Modal,
  PageHeader,
  time,
} from "../../shared/ui";

type Secret = components["schemas"]["IntegrationTokenSecret"];
function tokenState(token: IntegrationToken) {
  return token.revoked_at
    ? "Отозван"
    : Date.parse(token.expires_at) <= Date.now()
      ? "Срок истёк"
      : "Действует";
}
export function IntegrationsPage() {
  const { can } = usePermissions(),
    client = useQueryClient();
  const [creating, setCreating] = useState(false),
    [target, setTarget] = useState<IntegrationToken | null>(null);
  const [revoking, setRevoking] = useState(false),
    [revokeError, setRevokeError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const q = useQuery({
    queryKey: ["integration-tokens"],
    queryFn: api.integrationTokens,
    enabled: can("admin"),
    refetchInterval: 30000,
  });
  const deployments = useQuery({
    queryKey: ["deployments"],
    queryFn: api.deployments,
    enabled: can("admin"),
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["integration-tokens"] });
    void client.invalidateQueries({ queryKey: ["audit"] });
    void client.invalidateQueries({ queryKey: ["blocks"] });
    void client.invalidateQueries({ queryKey: ["report"] });
  };
  if (!can("admin")) return <PermissionNote permission="admin" />;
  async function revoke() {
    if (!target || revoking || !can("admin")) return;
    setRevoking(true);
    setRevokeError(null);
    try {
      const result = await api.revokeIntegrationToken(target.id);
      client.setQueryData<IntegrationToken[]>(["integration-tokens"], (old) =>
        old?.map((t) => (t.id === result.id ? result : t)),
      );
      setTarget(null);
      setNotice(
        "Ключ отозван. Для действующих ограничений этого ключа запрошена отмена; снятие подтверждается агентом отдельно.",
      );
      refresh();
    } catch (e) {
      setRevokeError(e);
    } finally {
      setRevoking(false);
    }
  }
  return (
    <>
      <PageHeader
        title="Интеграции"
        description="Ключи доступа для получения событий и ограниченных ответных действий."
        action={
          <button
            className="button primary"
            onClick={() => {
              setNotice("");
              setCreating(true);
            }}
          >
            <Plus size={15} />
            Создать ключ
          </button>
        }
      />
      <p className="permission-note integration-intro">
        API отдаёт совместимый с ECS 8.0 поднабор событий. Внешний SIEM не
        подключён. Reference receiver запускается отдельно; его состояние здесь
        не проверяется.
      </p>
      {notice && (
        <p className="permission-note" role="status">
          {notice}
        </p>
      )}
      <ErrorNotice error={q.error} onRetry={() => q.refetch()} />
      <div className="integration-list-heading">
        <h2>Ключи доступа</h2>
        <button
          className="button small"
          disabled={q.isFetching}
          onClick={() => q.refetch()}
        >
          <RefreshCw size={14} />
          Обновить
        </button>
      </div>
      {q.isPending ? (
        <Loading />
      ) : (
        q.data && (
          <>
            {q.data.length ? (
              <div className="integration-list">
                {q.data.map((token) => {
                  const deployment = deployments.data?.find(
                    (d) => d.id === token.deployment_id,
                  );
                  return (
                    <article className="integration-row" key={token.id}>
                      <div className="integration-row-heading">
                        <div>
                          <h3>{token.name}</h3>
                          <p>
                            {token.allow_response
                              ? "Чтение и ответные действия"
                              : "Только чтение"}{" "}
                            ·{" "}
                            {token.deployment_id ? (
                              <Link to={`/traps/${token.deployment_id}`}>
                                {deployment?.name ?? "Выбранная ловушка"}
                              </Link>
                            ) : (
                              "Все ловушки"
                            )}
                          </p>
                        </div>
                        <div className="integration-row-actions">
                          <span>{tokenState(token)}</span>
                          <button
                            className="button small"
                            disabled={Boolean(token.revoked_at)}
                            aria-label={`Отозвать ключ ${token.name}`}
                            onClick={() => {
                              setTarget(token);
                              setRevokeError(null);
                            }}
                          >
                            Отозвать
                          </button>
                        </div>
                      </div>
                      <p className="integration-dates">
                        До {time(token.expires_at, true)} ·{" "}
                        {token.last_used_at
                          ? `Последний запрос: ${time(token.last_used_at, true)}`
                          : "Нет данных об использовании"}
                      </p>
                      <details className="integration-details">
                        <summary>Сведения о ключе</summary>
                        <dl>
                          <dt>Идентификатор</dt>
                          <dd className="mono">{token.id}</dd>
                          <dt>Создан</dt>
                          <dd>{time(token.created_at, true)}</dd>
                          <dt>Создал</dt>
                          <dd>{token.created_by}</dd>
                          {token.revoked_at && (
                            <>
                              <dt>Отозван</dt>
                              <dd>{time(token.revoked_at, true)}</dd>
                            </>
                          )}
                          {token.deployment_id && (
                            <>
                              <dt>Ловушка</dt>
                              <dd className="mono">{token.deployment_id}</dd>
                            </>
                          )}
                        </dl>
                      </details>
                    </article>
                  );
                })}
              </div>
            ) : (
              <Empty
                title="Ключей пока нет"
                description="Создайте ключ только для чтения или ограничьте его одной ловушкой."
              />
            )}
            {q.data.length >= 200 && (
              <p className="permission-note">Показаны последние 200 ключей.</p>
            )}
          </>
        )
      )}
      <details className="integration-guide">
        <summary>Как подключить получатель событий</summary>
        <IntegrationGuide />
      </details>
      {creating && (
        <CreateKey onClose={() => setCreating(false)} onCreated={refresh} />
      )}
      <Modal
        open={Boolean(target)}
        onClose={() => {
          if (!revoking) setTarget(null);
        }}
        title={`Отозвать ключ «${target?.name ?? ""}»`}
        description="Ключ перестанет принимать запросы. Принадлежащие ему действующие ограничения будут направлены на отмену; результат зависит от подтверждения агента."
      >
        <p className="permission-note">
          Секрет нельзя восстановить. Для повторного доступа потребуется новый
          ключ. Отмена ограничений не восстанавливает уже завершённые
          SSH-сессии.
        </p>
        <ErrorNotice error={revokeError} />
        <div className="actions">
          <button
            className="button"
            disabled={revoking}
            onClick={() => setTarget(null)}
          >
            Отмена
          </button>
          <button
            className="button danger"
            disabled={revoking}
            onClick={revoke}
          >
            {revoking ? "Отзываем…" : "Отозвать ключ"}
          </button>
        </div>
      </Modal>
    </>
  );
}

function CreateKey({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { can } = usePermissions();
  const [name, setName] = useState(""),
    [deployment, setDeployment] = useState(""),
    [days, setDays] = useState("30"),
    [response, setResponse] = useState(false);
  // The secret stays only in this mounted dialog, never in query/mutation caches or storage.
  const [secret, setSecret] = useState<Secret | null>(null),
    [visible, setVisible] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(null);
  const mounted = useRef(true),
    inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const q = useQuery({
    queryKey: ["deployments"],
    queryFn: api.deployments,
    enabled: can("admin"),
  });
  const valid =
    name.trim().length > 0 &&
    Number.isInteger(Number(days)) &&
    Number(days) >= 1 &&
    Number(days) <= 365 &&
    (!response || Boolean(deployment));
  function close() {
    if (!inFlight.current) {
      setSecret(null);
      setVisible(false);
      onClose();
    }
  }
  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || inFlight.current || !can("admin")) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await api.createIntegrationToken({
        name: name.trim(),
        deployment_id: deployment || null,
        expires_days: Number(days),
        allow_response: response,
      });
      if (mounted.current) {
        setSecret(result);
        onCreated();
      }
    } catch (e) {
      if (mounted.current) setError(e);
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  }
  if (!can("admin")) return null;
  return (
    <Modal
      open
      onClose={close}
      title={secret ? "Сохраните ключ" : "Создать ключ интеграции"}
      description={
        secret
          ? "Секрет показан только сейчас. После закрытия его нельзя получить повторно."
          : "По умолчанию ключ может только читать события."
      }
    >
      {secret ? (
        <div className="integration-secret">
          <Field label="Ключ доступа">
            <input
              className="mono"
              type={visible ? "text" : "password"}
              readOnly
              value={secret.token}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <div className="actions">
            <button
              className="button small"
              onClick={() => setVisible((v) => !v)}
            >
              {visible ? "Скрыть ключ" : "Показать ключ"}
            </button>
            <CopyButton value={secret.token} label="Копировать ключ" />
          </div>
          <p className="permission-note">
            {secret.integration.name} ·{" "}
            {secret.integration.allow_response
              ? "Чтение и ответные действия"
              : "Только чтение"}
            . Действует до {time(secret.integration.expires_at, true)}.
          </p>
          <p className="permission-note">
            Сохраните секрет в защищённом хранилище получателя. Копирование
            помещает его в буфер обмена. Закрытие очищает секрет из этого окна;
            буфер обмена остаётся под вашим управлением.
          </p>
          <div className="actions">
            <button className="button primary" onClick={close}>
              Закрыть и очистить
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={create}>
          <Field label="Название">
            <input
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={pending}
              autoComplete="off"
            />
          </Field>
          <Field
            label="Ловушка"
            hint={
              response
                ? "Ответные действия требуют одной выбранной ловушки."
                : "Можно ограничить чтение одной ловушкой."
            }
          >
            <select
              value={deployment}
              onChange={(e) => setDeployment(e.target.value)}
              disabled={pending || q.isPending}
            >
              <option value="">
                {response ? "Выберите ловушку" : "Все ловушки"}
              </option>
              {q.data?.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <ErrorNotice error={q.error} onRetry={() => q.refetch()} />
          <Field label="Срок действия, дней" hint="От 1 до 365 дней">
            <input
              type="number"
              required
              min={1}
              max={365}
              step={1}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              disabled={pending}
            />
          </Field>
          <label className="integration-response">
            <input
              type="checkbox"
              checked={response}
              onChange={(e) => setResponse(e.target.checked)}
              disabled={pending}
            />
            <span>Разрешить ответные действия</span>
          </label>
          {response && (
            <p className="permission-note">
              По сохранённому событию выбранной ловушки ключ может запросить
              ограничение на 60–300 секунд и завершение SSH-сессий. Новые
              подключения и закрытие сессий подтверждаются агентом отдельно. Это
              не изоляция всей машины.
            </p>
          )}
          <ErrorNotice error={error} />
          {Boolean(error) && (
            <p className="permission-note">
              Если связь оборвалась во время создания, проверьте список ключей
              перед повтором. Секрет уже созданного ключа восстановить нельзя;
              ненужный ключ можно отозвать.
            </p>
          )}
          <div className="actions">
            <button
              className="button"
              type="button"
              disabled={pending}
              onClick={close}
            >
              Отмена
            </button>
            <button className="button primary" disabled={pending || !valid}>
              {pending ? "Создаём…" : "Создать ключ"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function IntegrationGuide() {
  return (
    <div className="integration-guide-content">
      <p>
        Получатель обращается к <code>GET /integration/v1/events</code> с
        заголовком <code>Authorization: Bearer</code>. Передавайте{" "}
        <code>after</code> из <code>next_cursor</code> предыдущего ответа и{" "}
        <code>limit</code> от 1 до 500. Если <code>has_more</code> истинно,
        продолжайте чтение; при <code>reset_required</code> требуется сброс
        курсора.
      </p>
      <pre className="code">{`curl "$HONEYFORGE_URL/integration/v1/events?after=0&limit=100" -H "Authorization: Bearer $HONEYFORGE_TOKEN"`}</pre>
      <p>
        Текущий API возвращает <code>honeyforge-ecs-events-v1</code>,
        совместимый с ECS 8.0 поднабор. Параметр выбора native/ecs текущим
        контрактом не предусмотрен. Приём и обработку событий на стороне SIEM
        нужно настроить отдельно.
      </p>
      <details>
        <summary>Ответные действия через API</summary>
        <p>
          Нужен ключ с разрешёнными ответными действиями и одной выбранной
          ловушкой. В <code>POST /integration/v1/source-blocks</code> передайте{" "}
          <code>event_id</code> из <code>event.id</code> полученного события,{" "}
          <code>ttl_seconds</code> 60–300 и <code>reason</code>. Заголовок{" "}
          <code>Idempotency-Key</code> обязателен (8–100 символов); повтор
          одного действия использует тот же ключ.
        </p>
        <pre className="code">
          {JSON.stringify(
            {
              event_id: "UUID события",
              ttl_seconds: 60,
              reason: "Причина ограничения",
            },
            null,
            2,
          )}
        </pre>
        <p>
          Ответ 202 означает запрос, а не применение. Проверяйте{" "}
          <code>GET /integration/v1/source-blocks/&#123;id&#125;</code>:
          ограничение новых подключений и завершение SSH отражаются отдельно по
          ACK. Реакция действует только в выбранной ловушке. Отзыв ключа
          запрашивает отмену принадлежащих ему действующих ограничений; закрытые
          SSH-сессии не восстанавливаются.
        </p>
      </details>
    </div>
  );
}
