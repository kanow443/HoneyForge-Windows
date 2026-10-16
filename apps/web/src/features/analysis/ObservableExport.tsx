import { useEffect, useRef, useState } from "react";
import { api } from "../../shared/api/client";
import type { components } from "../../shared/api/generated";
import type { Filters } from "../../shared/api/models";
import { ErrorNotice, Field, Modal } from "../../shared/ui";
import { usePermissions } from "../auth/permissions";
type Export = components["schemas"]["IoCExportView"];

export function ObservableExport({
  sessionId,
  filters,
}: {
  sessionId?: string;
  filters?: Filters;
}) {
  const { can } = usePermissions(),
    allowed = can("investigate");
  const [open, setOpen] = useState(false),
    [format, setFormat] = useState<"csv" | "stix">("stix"),
    [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(null),
    [result, setResult] = useState<Export | null>(null);
  const serial = useRef(0);
  function close() {
    serial.current++;
    setOpen(false);
    setPending(false);
    setError(null);
    setResult(null);
  }
  useEffect(() => {
    close();
    return () => {
      serial.current++;
    };
  }, [allowed, sessionId, JSON.stringify(filters)]);
  async function download() {
    if (!allowed || pending) return;
    const request = ++serial.current;
    setPending(true);
    setError(null);
    setResult(null);
    // Pagination is a screen concern; export selects all matching events up to the server limit.
    const { limit: _limit, offset: _offset, ...selection } = filters ?? {};
    try {
      const value = await api.iocExport({
        format,
        filters: { ...selection, limit: 100, offset: 0 },
        session_id: sessionId ?? null,
      });
      if (serial.current !== request) return;
      if (value.format !== format)
        throw new Error("Формат ответа не совпал с выбранным.");
      if (format === "stix" && JSON.parse(value.content).type !== "bundle")
        throw new Error("Сервер не вернул STIX Bundle. Файл не скачан.");
      const url = URL.createObjectURL(
        new Blob([value.content], { type: value.media_type }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = value.filename.replace(/[/\\]/g, "_");
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setResult(value);
    } catch (value) {
      if (serial.current === request) setError(value);
    } finally {
      if (serial.current === request) setPending(false);
    }
  }
  return (
    <>
      <button
        className="button small"
        disabled={!allowed}
        onClick={() => {
          setError(null);
          setResult(null);
          setOpen(true);
        }}
      >
        IOC CSV / STIX
      </button>
      <Modal
        open={open}
        onClose={close}
        title="Экспорт наблюдений"
        description={
          sessionId
            ? "Только события выбранной сессии."
            : "Текущие фильтры журнала; все соответствующие события в пределах серверного лимита."
        }
      >
        <p className="permission-note">
          Наблюдаемые IP и независимо проверенные хеши файлов со ссылками на
          события. Адрес не доказывает личность или вредоносность. STIX содержит
          Observed Data, а не утверждение об атакующем.
        </p>
        <Field label="Формат экспорта">
          <select
            value={format}
            disabled={pending}
            onChange={(event) => {
              setFormat(event.target.value as "csv" | "stix");
              setResult(null);
            }}
          >
            <option value="stix">STIX 2.1 · Observed Data</option>
            <option value="csv">CSV · наблюдения и ссылки</option>
          </select>
        </Field>
        <ErrorNotice error={error} />
        {result && (
          <p role="status">
            Файл подготовлен: {result.event_count} событий
            {result.truncated
              ? " из " + result.total + " — выборка ограничена сервером"
              : ""}
            .
          </p>
        )}
        <div className="actions">
          <button className="button" onClick={close}>
            Закрыть
          </button>
          <button
            className="button primary"
            disabled={pending || !allowed}
            onClick={download}
          >
            {pending ? "Готовим…" : "Скачать наблюдения"}
          </button>
        </div>
      </Modal>
    </>
  );
}
