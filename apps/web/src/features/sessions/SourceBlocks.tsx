import { useState, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Undo2 } from "lucide-react";
import { api, errorText } from "../../shared/api/client";
import type { SourceBlock } from "../../shared/api/models";
import { ErrorNotice, Field, Modal, time } from "../../shared/ui";
import { TerminationResult } from "./TerminationResult";
import { PermissionNote, usePermissions } from "../auth/permissions";

export const blockLabels: Record<SourceBlock["state"], string> = {
  pending: "Ожидает применения",
  applied: "Подтверждено агентом",
  cancelled: "Отменено",
  expired: "Срок истёк",
  error: "Ошибка применения",
  unknown: "Нет подтверждения",
  superseded: "Запуск изменился",
};
export function BlockState({
  block,
  snapshot = false,
}: {
  block: SourceBlock;
  snapshot?: boolean;
}) {
  const expired =
    !snapshot &&
    block.state === "applied" &&
    Date.parse(block.expires_at) <= Date.now();
  const cancelling =
    block.desired_state === "released" &&
    ["pending", "unknown"].includes(block.state);
  return (
    <span className="firewall-result">
      <small>Новые подключения</small>
      <span
        key={`${block.state}:${block.desired_state}:${expired}`}
        className={`block-state motion-feedback block-${expired ? "pending" : block.state}`}
      >
        {cancelling
          ? "Ожидает подтверждения отмены"
          : expired
            ? "Срок истёк, обновляем состояние"
            : blockLabels[block.state]}
      </span>
    </span>
  );
}
export function SourceBlocks({
  deploymentId,
  sourceIp,
  compact = false,
  deploymentName,
  endpoint,
  adapter,
}: {
  deploymentId: string;
  sourceIp?: string;
  compact?: boolean;
  deploymentName?: string;
  endpoint?: string;
  adapter: string;
}) {
  const { can } = usePermissions();
  const isSsh = adapter === "cowrie";
  const client = useQueryClient(),
    [open, setOpen] = useState(false),
    [ip, setIp] = useState(sourceIp ?? ""),
    [ttl, setTtl] = useState(60),
    [reason, setReason] = useState(""),
    [terminate, setTerminate] = useState(true),
    [formError, setFormError] = useState("");
  const key = useRef(crypto.randomUUID());
  const q = useQuery({
    queryKey: ["blocks", deploymentId],
    queryFn: () => api.blocks(deploymentId),
    refetchInterval: 5000,
  });
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const create = useMutation({
    mutationFn: () =>
      api.block(
        {
          deployment_id: deploymentId,
          source_ip: ip.trim(),
          ttl_seconds: ttl,
          reason: reason.trim(),
          terminate_sessions: isSsh && terminate,
        },
        key.current,
      ),
    onSuccess: () => {
      setOpen(false);
      setReason("");
      key.current = crypto.randomUUID();
      void client.invalidateQueries({ queryKey: ["blocks", deploymentId] });
      void client.invalidateQueries({ queryKey: ["audit"] });
      void client.invalidateQueries({ queryKey: ["report"] });
    },
  });
  const cancel = useMutation({
    mutationFn: (b: SourceBlock) => api.cancelBlock(b.id, b.revision),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["blocks", deploymentId] });
      void client.invalidateQueries({ queryKey: ["audit"] });
      void client.invalidateQueries({ queryKey: ["report"] });
    },
  });
  function changed() {
    key.current = crypto.randomUUID();
    create.reset();
    setFormError("");
  }
  const blocks = (q.data ?? []).filter(
    (b) => !sourceIp || b.source_ip === sourceIp,
  );
  return (
    <section
      className={`source-blocks ${compact ? "compact" : ""}`}
      aria-label="Ограничения источника"
    >
      <div className="section-heading">
        <div>
          <h2>Ограничения доступа</h2>
          <p>
            {isSsh
              ? "Новые подключения и открытые SSH-сессии"
              : "Новые подключения к этой ловушке"}
          </p>
        </div>
        <button
          className="button small"
          disabled={!can("operate")}
          onClick={() => {
            setIp(sourceIp ?? "");
            setTerminate(true);
            changed();
            setOpen(true);
          }}
        >
          <Ban size={14} />
          {isSsh ? "Ограничить доступ" : "Заблокировать источник"}
        </button>
      </div>
      <PermissionNote permission="operate" />
      <ErrorNotice error={q.error} onRetry={() => q.refetch()} />
      <ErrorNotice error={cancel.error} />
      {q.isPending ? (
        <p className="quiet-empty">Загружаем ограничения…</p>
      ) : !blocks.length && !q.error ? (
        <p className="quiet-empty">
          Ограничений для {sourceIp ?? "этой ловушки"} пока нет.
        </p>
      ) : null}
      <div className="block-list">
        {blocks.map((b) => (
          <article key={b.id}>
            <div className="block-identity">
              <code>{b.source_ip}</code>
              <BlockState block={b} />
            </div>
            <p>{b.reason}</p>
            <div className="block-meta">
              <span>До {time(b.expires_at, true)}</span>
              <span>
                {b.created_by} · {time(b.created_at)}
              </span>
            </div>
            {b.observed_at && (
              <small>
                Ответ агента: {time(b.observed_at, true)} · ревизия{" "}
                {b.observed_revision} из {b.revision}
              </small>
            )}
            {b.error && <p className="bad">{b.error}</p>}
            {isSsh && <TerminationResult block={b} />}
            {b.desired_state === "blocked" &&
              !["cancelled", "expired", "superseded"].includes(b.state) && (
                <button
                  className="text-link"
                  disabled={cancel.isPending || !can("operate")}
                  onClick={() => cancel.mutate(b)}
                >
                  <Undo2 size={13} />
                  {cancel.isPending && cancel.variables?.id === b.id
                    ? "Запрашиваем отмену…"
                    : "Отменить ограничение"}
                </button>
              )}
          </article>
        ))}
      </div>
      <Modal
        open={open && can("operate")}
        onClose={() => {
          if (!create.isPending) setOpen(false);
        }}
        title={
          isSsh && terminate
            ? "Ограничить доступ и завершить SSH-сессии"
            : "Ограничить новые подключения"
        }
        description={
          isSsh
            ? "Действие касается только выбранной ловушки. Ограничение новых подключений и завершение сессий подтверждаются агентом отдельно."
            : "Ограничение действует на новые подключения к одной ловушке."
        }
      >
        <form
          className="source-block-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!can("operate")) return;
            if (
              !ip.trim() ||
              !reason.trim() ||
              !Number.isInteger(ttl) ||
              ttl < 60 ||
              ttl > 3600
            ) {
              setFormError("Укажите IP, причину и срок от 60 до 3600 секунд.");
              return;
            }
            create.mutate();
          }}
        >
          <div className="block-form-address">
            <Field label="IP источника">
              <input
                data-initial-focus
                disabled={create.isPending}
                value={ip}
                readOnly={Boolean(sourceIp)}
                onChange={(e) => {
                  setIp(e.target.value);
                  changed();
                }}
                required
                maxLength={45}
              />
            </Field>
            <Field label="Срок ограничения">
              <select
                disabled={create.isPending}
                value={ttl}
                onChange={(e) => {
                  setTtl(Number(e.target.value));
                  changed();
                }}
              >
                <option value={60}>1 минута — для демонстрации</option>
                <option value={300}>5 минут</option>
                <option value={900}>15 минут</option>
                <option value={3600}>1 час</option>
              </select>
            </Field>
          </div>
          <Field label="Причина">
            <textarea
              disabled={create.isPending}
              rows={2}
              value={reason}
              required
              maxLength={500}
              onChange={(e) => {
                setReason(e.target.value);
                changed();
              }}
              placeholder="Какое наблюдение требует ограничения"
            />
          </Field>
          {isSsh && (
            <label className="termination-choice">
              <input
                type="checkbox"
                checked={terminate}
                disabled={create.isPending}
                onChange={(e) => {
                  setTerminate(e.target.checked);
                  changed();
                }}
              />
              <span>
                <strong>Завершить открытые SSH-сессии</strong>
                <small>
                  Для этого источника в выбранной ловушке. Отмена ограничения не
                  восстановит закрытые соединения.
                </small>
              </span>
            </label>
          )}
          <div className="block-scope">
            <strong>Область действия</strong>
            <strong>{deploymentName ?? "Выбранная ловушка"}</strong>
            {endpoint && <code>{endpoint}</code>}
            <span>
              Это ограничение доступа к приманке. Срок снимается сенсором даже
              без связи с сервером.
            </span>
          </div>
          {formError && (
            <p role="alert" className="bad">
              {formError}
            </p>
          )}
          {create.error && (
            <p role="alert" className="bad">
              {errorText(create.error)}
            </p>
          )}
          <div className="actions block-actions">
            <button
              type="button"
              className="button"
              disabled={create.isPending}
              onClick={() => setOpen(false)}
            >
              Отмена
            </button>
            <button className="button danger" disabled={create.isPending}>
              {create.isPending
                ? "Отправляем запрос…"
                : isSsh && terminate
                  ? "Ограничить доступ и завершить сессии"
                  : "Запросить ограничение"}
            </button>
          </div>
        </form>
      </Modal>
    </section>
  );
}
