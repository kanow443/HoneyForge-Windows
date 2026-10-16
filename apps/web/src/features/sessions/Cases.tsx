import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowRight, FolderPlus, Plus } from "lucide-react";
import { api } from "../../shared/api/client";
import type { InvestigationCase, Session } from "../../shared/api/models";
import { PermissionNote, usePermissions } from "../auth/permissions";
import {
  Empty,
  ErrorNotice,
  Field,
  Loading,
  Modal,
  PageHeader,
  time,
} from "../../shared/ui";

const caseLabels = {
  new: "Новое",
  investigating: "В работе",
  closed: "Закрыто",
};
export function CreateCase({
  sessions,
  initialIds = [],
  title = "",
}: {
  sessions: Session[];
  initialIds?: string[];
  title?: string;
}) {
  const { can } = usePermissions();
  const client = useQueryClient(),
    [open, setOpen] = useState(false),
    [name, setName] = useState(title),
    [note, setNote] = useState(""),
    [ids, setIds] = useState(initialIds),
    [created, setCreated] = useState<InvestigationCase | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api.createCase({ title: name.trim(), session_ids: ids, note }),
    onSuccess: (c) => {
      setCreated(c);
      setOpen(false);
      void client.invalidateQueries({ queryKey: ["cases"] });
      void client.invalidateQueries({ queryKey: ["audit"] });
    },
  });
  return (
    <>
      <button
        className="button"
        disabled={!can("investigate")}
        onClick={() => {
          setOpen(true);
          create.reset();
        }}
      >
        <FolderPlus size={15} />
        Создать дело
      </button>
      <PermissionNote permission="investigate" />
      {created && (
        <Link className="text-link" to={`/cases?case=${created.id}`}>
          Открыть «{created.title}»<ArrowRight size={13} />
        </Link>
      )}
      <Modal
        open={open && can("investigate")}
        onClose={() => {
          if (!create.isPending) setOpen(false);
        }}
        title="Новое расследование"
        description="Сохраните выбранные сессии и заметку оператора. Совпадение IP не доказывает общую личность."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (can("investigate") && name.trim() && ids.length)
              create.mutate();
          }}
        >
          <Field label="Название дела">
            <input
              data-initial-focus
              required
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <fieldset className="case-session-picker">
            <legend>Сессии · {ids.length} из 20</legend>
            {sessions.map((s) => (
              <label key={s.id}>
                <input
                  type="checkbox"
                  checked={ids.includes(s.id)}
                  disabled={!ids.includes(s.id) && ids.length >= 20}
                  onChange={(e) =>
                    setIds((old) =>
                      e.target.checked
                        ? [...old, s.id]
                        : old.filter((id) => id !== s.id),
                    )
                  }
                />
                <span>
                  <code>{s.source_ip}</code>
                  <small>
                    {s.deployment_name} · {time(s.started_at)}
                  </small>
                </span>
              </label>
            ))}
            {!sessions.length && <p>Нет доступных сессий.</p>}
          </fieldset>
          <Field label="Заметка оператора">
            <textarea
              rows={4}
              maxLength={4000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <ErrorNotice error={create.error} />
          <div className="actions">
            <button
              className="button"
              type="button"
              disabled={create.isPending}
              onClick={() => setOpen(false)}
            >
              Отмена
            </button>
            <button
              className="button primary"
              disabled={create.isPending || !name.trim() || !ids.length}
            >
              {create.isPending ? "Сохраняем…" : "Создать дело"}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
export function CasesPage() {
  const q = useQuery({
      queryKey: ["cases"],
      queryFn: api.cases,
      refetchInterval: 15000,
    }),
    sessions = useQuery({
      queryKey: ["sessions"],
      queryFn: () => api.sessions(),
    }),
    [params, setParams] = useSearchParams();
  if (q.isPending) return <Loading />;
  if (q.error)
    return <ErrorNotice error={q.error} onRetry={() => q.refetch()} />;
  const selected = q.data.find((c) => c.id === params.get("case")) ?? q.data[0];
  return (
    <>
      <PageHeader
        title="Расследования"
        description="Сессии, наблюдения и решения оператора."
        action={<CreateCase sessions={sessions.data ?? []} />}
      />
      <ErrorNotice error={sessions.error} />
      {!q.data.length ? (
        <Empty
          title="Первое дело начинается с наблюдения"
          description="Откройте сессию или выберите несколько сессий для одного расследования."
          action={
            <Link to="/events" className="button">
              Открыть события
            </Link>
          }
        />
      ) : (
        <div className="cases-workspace">
          <div className="case-register">
            {q.data.map((c) => (
              <button
                className={selected?.id === c.id ? "selected" : ""}
                key={c.id}
                onClick={() => setParams({ case: c.id })}
              >
                <span className={`case-status case-${c.status}`}>
                  {caseLabels[c.status]}
                </span>
                <strong>{c.title}</strong>
                {c.retention_pinned && <small>Доказательства закреплены</small>}
                <small>
                  {c.session_ids.length}{" "}
                  {c.session_ids.length === 1
                    ? "сессия"
                    : c.session_ids.length >= 2 && c.session_ids.length <= 4
                      ? "сессии"
                      : "сессий"}{" "}
                  · {time(c.updated_at)}
                </small>
              </button>
            ))}
          </div>
          {selected && (
            <CaseEditor
              key={selected.id}
              item={selected}
              sessions={sessions.data ?? []}
            />
          )}
        </div>
      )}
    </>
  );
}
function CaseEditor({
  item,
  sessions,
}: {
  item: InvestigationCase;
  sessions: Session[];
}) {
  const { can } = usePermissions();
  const client = useQueryClient(),
    [note, setNote] = useState(item.note),
    [status, setStatus] = useState(item.status),
    [revision, setRevision] = useState(item.revision),
    [saved, setSaved] = useState(false),
    [unpinReview, setUnpinReview] = useState(false);
  const update = useMutation({
    mutationFn: () => api.updateCase(item.id, { revision, status, note }),
    onSuccess: (c) => {
      setRevision(c.revision);
      setSaved(true);
      client.setQueryData<InvestigationCase[]>(["cases"], (old) =>
        old?.map((item) => (item.id === c.id ? c : item)),
      );
      void client.invalidateQueries({ queryKey: ["cases"] });
      void client.invalidateQueries({ queryKey: ["audit"] });
    },
  });
  const pin = useMutation({
    mutationFn: () =>
      api.caseRetention(item.id, { revision, pinned: !item.retention_pinned }),
    onSuccess: (c) => {
      setUnpinReview(false);
      setRevision(c.revision);
      client.setQueryData<InvestigationCase[]>(["cases"], (old) =>
        old?.map((v) => (v.id === c.id ? c : v)),
      );
      void client.invalidateQueries({ queryKey: ["cases"] });
      void client.invalidateQueries({ queryKey: ["storage"] });
      void client.invalidateQueries({ queryKey: ["audit"] });
    },
  });
  useEffect(() => {
    setSaved(false);
  }, [note, status]);
  return (
    <section className="case-editor">
      <header>
        <h2>{item.title}</h2>
        <span>
          Создано {time(item.created_at, true)} · {item.created_by}
        </span>
      </header>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (
            can("investigate") &&
            !pin.isPending &&
            !update.isPending &&
            item.revision === revision
          )
            update.mutate();
        }}
      >
        <Field label="Состояние дела">
          <select
            disabled={!can("investigate")}
            value={status}
            onChange={(e) =>
              setStatus(e.target.value as InvestigationCase["status"])
            }
          >
            {Object.entries(caseLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Заметка оператора">
          <textarea
            readOnly={!can("investigate")}
            rows={8}
            maxLength={4000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        {item.revision !== revision && (
          <p className="info-note">
            Дело изменено другим оператором.{" "}
            <button
              type="button"
              className="text-link"
              onClick={() => {
                setRevision(item.revision);
                setStatus(item.status);
                setNote(item.note);
                update.reset();
                pin.reset();
              }}
            >
              Загрузить актуальную версию
            </button>
          </p>
        )}
        <ErrorNotice error={update.error} />
        <div className="actions">
          <button
            className="button primary"
            disabled={
              update.isPending ||
              pin.isPending ||
              item.revision !== revision ||
              !can("investigate")
            }
          >
            {update.isPending ? "Сохраняем…" : "Сохранить изменения"}
          </button>
          {saved && (
            <span className="good motion-feedback" role="status">
              Изменения сохранены
            </span>
          )}
        </div>
      </form>
      <PermissionNote permission="investigate" />
      <div className="case-retention">
        <h3>Хранение доказательств</h3>
        <p className="permission-note">
          {item.retention_pinned
            ? "Связанные сессии и доказательства защищены от плановой очистки."
            : "Действует обычный срок хранения. Закрепите дело, чтобы сохранить связанные сессии и доказательства."}
        </p>
        <button
          type="button"
          className="button small"
          disabled={
            !can("investigate") ||
            pin.isPending ||
            update.isPending ||
            item.revision !== revision
          }
          onClick={() => {
            if (
              can("investigate") &&
              item.revision === revision &&
              !update.isPending
            ) {
              if (item.retention_pinned) setUnpinReview(true);
              else pin.mutate();
            }
          }}
        >
          {pin.isPending
            ? "Обновляем…"
            : item.retention_pinned
              ? "Снять закрепление"
              : "Закрепить доказательства"}
        </button>
        {item.retention_pinned && (
          <p className="permission-note">
            После снятия закрепления истёкшие данные могут быть удалены при
            следующей очистке.
          </p>
        )}
        <ErrorNotice error={pin.error} />
        <Link className="text-link" to="/storage">
          Сроки и лимиты хранения
        </Link>
      </div>
      <Modal
        open={unpinReview}
        onClose={() => {
          if (!pin.isPending) setUnpinReview(false);
        }}
        title="Снять закрепление доказательств"
        description="Снова начнут действовать обычные сроки хранения. Истёкшие данные могут быть удалены при следующей очистке; удалённое содержимое не восстанавливается."
      >
        <ErrorNotice error={pin.error} />
        <div className="actions">
          <button
            type="button"
            className="button"
            disabled={pin.isPending}
            onClick={() => setUnpinReview(false)}
          >
            Отмена
          </button>
          <button
            type="button"
            className="button danger"
            disabled={
              pin.isPending || item.revision !== revision || !can("investigate")
            }
            onClick={() => {
              if (can("investigate") && item.revision === revision)
                pin.mutate();
            }}
          >
            {pin.isPending ? "Обновляем…" : "Снять закрепление"}
          </button>
        </div>
      </Modal>
      <h3>Связанные сессии</h3>
      <div className="case-session-links">
        {item.session_ids.map((id) => {
          const s = sessions.find((s) => s.id === id);
          return (
            <div key={id}>
              <Link to={`/sessions/${id}`}>
                <strong>{s?.source_ip ?? "Открыть сессию"}</strong>
                <span>{s?.deployment_name ?? id}</span>
                <ArrowRight size={14} />
              </Link>
              <Link className="text-link" to={`/sessions/${id}/report`}>
                Отчёт
              </Link>
            </div>
          );
        })}
      </div>
      <Link className="text-link" to="/audit">
        История действий оператора
        <Plus size={12} />
      </Link>
    </section>
  );
}
