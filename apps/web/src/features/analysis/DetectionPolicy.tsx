import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../shared/api/client";
import type { components } from "../../shared/api/generated";
import { ErrorNotice, Field, Loading, Modal, time } from "../../shared/ui";
import { usePermissions } from "../auth/permissions";
type Policy = components["schemas"]["DetectionPolicyView"];
export function DetectionPolicy() {
  const { can } = usePermissions(),
    client = useQueryClient();
  const [expanded, setExpanded] = useState(false),
    [draft, setDraft] = useState<Policy | null>(null);
  const q = useQuery({
    queryKey: ["detection-policy"],
    queryFn: api.detectionPolicy,
    enabled: expanded,
    refetchInterval: expanded ? 15000 : false,
  });
  const save = useMutation({
    mutationFn: () => {
      if (!can("operate") || !draft)
        throw new Error("Настройка правила недоступна");
      return api.updateDetectionPolicy({
        revision: draft.revision,
        failed_logins: draft.failed_logins,
        window_seconds: draft.window_seconds,
        enabled: draft.enabled,
      });
    },
    onSuccess: (value) => {
      client.setQueryData(["detection-policy"], value);
      setDraft(null);
      void client.invalidateQueries({ queryKey: ["audit"] });
    },
    onError: (value) => {
      if (value instanceof ApiError && value.status === 409) void q.refetch();
    },
  });
  const stale = Boolean(draft && q.data && draft.revision !== q.data.revision);
  return (
    <details
      className="technical-details analysis-settings"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>Правило повторных входов</summary>
      {expanded && (
        <div className="panel-padding">
          <ErrorNotice error={q.error} onRetry={() => q.refetch()} />
          {q.isPending ? (
            <Loading />
          ) : (
            q.data && (
              <div className="section-toolbar">
                <div>
                  <strong>
                    {q.data.enabled ? "Включено" : "Выключено"} ·{" "}
                    {q.data.failed_logins} неудачных входов за{" "}
                    {q.data.window_seconds} секунд
                  </strong>
                  <p className="muted">
                    Версия настройки {q.data.revision}
                    {q.data.updated_at
                      ? " · " + time(q.data.updated_at, true)
                      : " · исходная настройка сервера"}
                  </p>
                </div>
                <button
                  className="button small"
                  disabled={!can("operate")}
                  onClick={() => {
                    save.reset();
                    setDraft(q.data);
                  }}
                >
                  Изменить правило
                </button>
              </div>
            )
          )}
          <p className="permission-note">
            Фиксированные окна по времени наблюдения на одной ловушке и
            источнике. Поздние события из разных окон не объединяются.
            Исторические срабатывания сохраняются без новой LIVE-тревоги;
            изменение не пересчитывает всю историю.
          </p>
        </div>
      )}
      <Modal
        open={Boolean(draft)}
        onClose={() => {
          if (!save.isPending) setDraft(null);
        }}
        title="Правило повторных входов"
        description="Изменение действует на следующие обработки событий. Доступно оператору и администратору."
      >
        {draft && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!save.isPending && !stale && can("operate")) save.mutate();
            }}
          >
            <label className="private-confirm">
              <input
                type="checkbox"
                checked={draft.enabled}
                disabled={save.isPending}
                onChange={(event) =>
                  setDraft({ ...draft, enabled: event.target.checked })
                }
              />
              Обнаруживать повторные неудачные входы
            </label>
            <Field label="Количество неудачных входов" hint="От 2 до 100">
              <input
                required
                type="number"
                min={2}
                max={100}
                step={1}
                value={draft.failed_logins}
                disabled={save.isPending}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    failed_logins: Number(event.target.value),
                  })
                }
              />
            </Field>
            <Field
              label="Фиксированное окно, секунд"
              hint="От 10 до 3600; используется время наблюдения, не доставки"
            >
              <input
                required
                type="number"
                min={10}
                max={3600}
                step={1}
                value={draft.window_seconds}
                disabled={save.isPending}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    window_seconds: Number(event.target.value),
                  })
                }
              />
            </Field>
            {stale && (
              <div className="info-note">
                Настройка изменилась. Ваш черновик сохранён.{" "}
                <button
                  type="button"
                  className="button small"
                  onClick={() => {
                    if (q.data) setDraft(q.data);
                    save.reset();
                  }}
                >
                  Загрузить актуальную настройку
                </button>
              </div>
            )}
            <ErrorNotice error={save.error} />
            <div className="actions">
              <button
                type="button"
                className="button"
                disabled={save.isPending}
                onClick={() => setDraft(null)}
              >
                Отмена
              </button>
              <button
                className="button primary"
                disabled={!can("operate") || save.isPending || stale}
              >
                {save.isPending ? "Сохраняем…" : "Сохранить правило"}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </details>
  );
}
