import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../shared/api/client";
import type { components } from "../../shared/api/generated";
import {
  CopyButton,
  Empty,
  ErrorNotice,
  KeyValue,
  Loading,
  Modal,
  time,
} from "../../shared/ui";
import { usePermissions } from "../auth/permissions";
type Certificate = components["schemas"]["AgentCertificateView"];
const states: Record<Certificate["state"], string> = {
  pending: "Ожидает подтверждения",
  active: "Подтверждён",
  overlap: "Период замены",
  revoked: "Отозван",
};
export function HostCertificates({ hostId }: { hostId: string }) {
  const { can } = usePermissions(),
    allowed = can("admin"),
    client = useQueryClient();
  const [expanded, setExpanded] = useState(false),
    [target, setTarget] = useState<Certificate | null>(null);
  const q = useQuery({
    queryKey: ["certificates", hostId],
    queryFn: () => api.hostCertificates(hostId),
    enabled: expanded && allowed,
    refetchInterval: expanded && allowed ? 15000 : false,
  });
  const revoke = useMutation({
    mutationFn: () => {
      if (!allowed || !target) throw new Error("Отзыв сертификата недоступен");
      return api.revokeCertificate(target.id);
    },
    onSuccess: () => {
      setTarget(null);
      void client.invalidateQueries({ queryKey: ["certificates", hostId] });
      void client.invalidateQueries({ queryKey: ["hosts"] });
      void client.invalidateQueries({ queryKey: ["audit"] });
    },
  });
  if (!allowed) return null;
  return (
    <details
      className="technical-details host-certificates"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>Сертификаты агента</summary>
      {expanded && (
        <div className="panel-padding">
          <p className="permission-note">
            Состояние выдачи и подтверждения сертификата. Наличие записи не
            доказывает, что текущий запрос агента прошёл по mTLS. Закрытые ключи
            в панели не отображаются.
          </p>
          <ErrorNotice error={q.error} onRetry={() => q.refetch()} />
          {q.isPending ? (
            <Loading />
          ) : q.data?.length ? (
            q.data.map((certificate) => (
              <article className="marker-row" key={certificate.id}>
                <div className="section-toolbar">
                  <strong>
                    {certificate.state !== "revoked" &&
                    Date.parse(certificate.accept_until) <= Date.now()
                      ? "Срок допуска истёк"
                      : states[certificate.state]}
                  </strong>
                  <button
                    className="button small"
                    disabled={certificate.state === "revoked" || !allowed}
                    onClick={() => {
                      revoke.reset();
                      setTarget(certificate);
                    }}
                  >
                    Отозвать сертификат
                  </button>
                </div>
                <KeyValue label="Отпечаток">
                  <code className="break-all">{certificate.fingerprint}</code>
                </KeyValue>
                <KeyValue label="Срок действия">
                  {time(certificate.expires_at, true)}
                </KeyValue>
                <KeyValue label="Допускается до">
                  {time(certificate.accept_until, true)}
                </KeyValue>
                <KeyValue label="Подтверждение">
                  {certificate.confirmed_at
                    ? time(certificate.confirmed_at, true)
                    : "Агент ещё не подтвердил"}
                </KeyValue>
                <details>
                  <summary>Открытый сертификат и сведения</summary>
                  <KeyValue label="Серийный номер">
                    <code>{certificate.serial}</code>
                  </KeyValue>
                  <KeyValue label="Хеш открытого ключа">
                    <code className="break-all">
                      {certificate.public_key_hash}
                    </code>
                  </KeyValue>
                  <pre className="code">{certificate.certificate_pem}</pre>
                  <CopyButton
                    value={certificate.certificate_pem}
                    label="Копировать открытый сертификат"
                  />
                </details>
              </article>
            ))
          ) : (
            !q.error && (
              <Empty
                title="Сертификатов этого агента пока нет"
                description="Регистрация хоста и выпуск сертификата — отдельные этапы. TLS подключается на агенте."
              />
            )
          )}
        </div>
      )}
      <Modal
        open={Boolean(target)}
        onClose={() => {
          if (!revoke.isPending) setTarget(null);
        }}
        title="Отозвать сертификат агента"
        description="Административное действие влияет на последующие проверки доступа этого сертификата."
      >
        <p>
          Убедитесь, что у агента есть другой действующий сертификат. Отзыв не
          выпускает замену и не подтверждает остановку работающих ловушек или
          SSH-сессий.
        </p>
        <KeyValue label="Отпечаток">
          <code className="break-all">{target?.fingerprint}</code>
        </KeyValue>
        <ErrorNotice error={revoke.error} />
        <div className="actions">
          <button
            className="button"
            disabled={revoke.isPending}
            onClick={() => setTarget(null)}
          >
            Отмена
          </button>
          <button
            className="button danger"
            disabled={!allowed || revoke.isPending}
            onClick={() => revoke.mutate()}
          >
            {revoke.isPending ? "Отзываем…" : "Отозвать сертификат"}
          </button>
        </div>
      </Modal>
    </details>
  );
}
