import { useEffect, useRef, useState } from "react";
import { api } from "../../shared/api/client";
import type { components } from "../../shared/api/generated";
import type { Event } from "../../shared/api/models";
import { usePermissions } from "../auth/permissions";
import { ErrorNotice, Field, Modal } from "../../shared/ui";
type Capture = components["schemas"]["PrivateCaptureView"];
export function PrivateCapture({ event }: { event: Event }) {
  const { can } = usePermissions(),
    allowed = can("investigate");
  const [open, setOpen] = useState(false),
    [confirmed, setConfirmed] = useState(false),
    [pending, setPending] = useState(false),
    [capture, setCapture] = useState<Capture | null>(null),
    [error, setError] = useState<unknown>(null),
    [showPassword, setShowPassword] = useState(false);
  const serial = useRef(0),
    scope = useRef({ id: event.id, allowed });
  scope.current = { id: event.id, allowed };
  function clear() {
    serial.current++;
    setCapture(null);
    setOpen(false);
    setPending(false);
    setConfirmed(false);
    setError(null);
    setShowPassword(false);
  }
  useEffect(() => {
    clear();
    return () => {
      serial.current++;
    };
  }, [event.id, allowed]);
  async function reveal() {
    if (!confirmed || pending || !scope.current.allowed) return;
    const request = ++serial.current,
      id = event.id;
    setPending(true);
    setError(null);
    try {
      const result = await api.privateCapture(id);
      if (result.event_id !== id)
        throw new Error(
          "Сервер вернул данные другого события. Содержимое не раскрыто.",
        );
      if (
        serial.current === request &&
        scope.current.id === id &&
        scope.current.allowed
      )
        setCapture(result);
    } catch (e) {
      if (
        serial.current === request &&
        scope.current.id === id &&
        scope.current.allowed
      )
        setError(e);
    } finally {
      if (serial.current === request) setPending(false);
    }
  }
  if (!event.private_capture_available) return null;
  if (!allowed)
    return (
      <p className="permission-note">
        Закрытые данные доступны аналитику, оператору и администратору.
      </p>
    );
  const content = capture?.content ?? {};
  const text = (key: string) =>
    typeof content[key] === "string" ? (content[key] as string) : undefined;
  return (
    <div className="private-capture">
      <button
        type="button"
        className="button small"
        onClick={() => {
          clear();
          setOpen(true);
        }}
      >
        Закрытые данные события
      </button>
      <Modal
        open={open}
        onClose={clear}
        title="Закрытые данные события"
        description="Данные загружаются только после подтверждения. Раскрытие фиксируется в журнале оператора; значения не входят в ленту и обычный экспорт."
      >
        {capture ? (
          <>
            <p className="permission-note">
              Событие <code>{capture.event_id}</code>
            </p>
            {text("username") !== undefined && (
              <Field label="Введённый логин">
                <input readOnly autoComplete="off" value={text("username")} />
              </Field>
            )}
            {text("password") !== undefined && (
              <>
                <Field label="Введённый пароль">
                  <input
                    type={showPassword ? "text" : "password"}
                    readOnly
                    autoComplete="off"
                    value={text("password")}
                  />
                </Field>
                <button
                  type="button"
                  className="button small"
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? "Скрыть пароль" : "Показать пароль"}
                </button>
              </>
            )}
            {text("http_payload_base64") !== undefined && (
              <Field
                label="HTTP payload, Base64"
                hint="Исходные байты в Base64. Содержимое не выполняется."
              >
                <textarea
                  readOnly
                  rows={5}
                  className="mono"
                  value={text("http_payload_base64")}
                />
              </Field>
            )}
            {typeof content.captured_bytes === "number" && (
              <p className="permission-note">
                Сохранено {content.captured_bytes} байт
                {typeof content.original_bytes === "number"
                  ? ` из ${content.original_bytes}`
                  : ""}
                .
              </p>
            )}
            {content.truncated === true && (
              <p className="permission-note">
                HTTP payload ограничен лимитом сбора; полное тело не сохранено.
              </p>
            )}
            {content.password_truncated === true && (
              <p className="permission-note">
                Пароль ограничен лимитом сбора; полное значение не сохранено.
              </p>
            )}
          </>
        ) : (
          <>
            <p className="permission-note">
              Проверьте, что раскрытие нужно для расследования. Значения
              очищаются при закрытии окна, смене события или потере доступа.
            </p>
            <label className="private-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                disabled={pending}
              />
              Подтверждаю раскрытие закрытых данных
            </label>
            <ErrorNotice error={error} />
          </>
        )}
        <div className="actions">
          <button type="button" className="button" onClick={clear}>
            {capture ? "Закрыть и очистить" : "Отмена"}
          </button>
          {!capture && (
            <button
              type="button"
              className="button primary"
              disabled={!confirmed || pending}
              onClick={reveal}
            >
              {pending ? "Загружаем…" : "Раскрыть данные"}
            </button>
          )}
        </div>
      </Modal>
    </div>
  );
}
