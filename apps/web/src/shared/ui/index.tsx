import {
  cloneElement,
  isValidElement,
  useId,
  useRef,
  type ReactElement,
  type ReactNode,
  type ComponentPropsWithoutRef,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Copy,
  LoaderCircle,
  Radio,
  X,
} from "lucide-react";
import { useState } from "react";
import { ApiError, errorText } from "../api/client";
import { useContentMotion } from "./motion";
export function Logo() {
  return (
    <span className="logo">
      <span>HoneyForge</span>
    </span>
  );
}
const labels: Record<string, string> = {
  running: "Работает",
  requested: "В очереди",
  applying: "Применяется",
  error: "Ошибка",
  stopping: "Останавливается",
  stopped: "Остановлена",
  unknown: "Неизвестно",
  mixed: "Разные состояния",
  online: "На связи",
  degraded: "С ограничениями",
  offline: "Не в сети",
  revoked: "Отозван",
  queued: "В очереди",
  leased: "Выполняется",
  succeeded: "Готово",
  failed: "Ошибка",
  expired: "Истёк срок",
  low: "Низкий",
  medium: "Средний",
  high: "Высокий",
};
export function Status({ value }: { value: string }) {
  const good = ["running", "online", "succeeded"].includes(value);
  const bad = ["error", "failed", "revoked"].includes(value);
  const warning = [
    "unknown",
    "mixed",
    "degraded",
    "applying",
    "requested",
    "stopping",
    "leased",
    "queued",
  ].includes(value);
  const Icon = good
    ? CheckCircle2
    : bad
      ? AlertCircle
      : warning
        ? Radio
        : Circle;
  return (
    <span
      className={`status ${good ? "good" : bad ? "bad" : warning ? "warn" : "muted"}`}
    >
      <Icon key={value} size={13} />
      {labels[value] ?? value}
    </span>
  );
}
export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <div className="eyebrow page-context">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action && <div className="actions">{action}</div>}
    </header>
  );
}
export function Panel({
  title,
  action,
  children,
  className = "",
  motionKey,
  ...attributes
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  motionKey?: string | number | boolean;
} & Omit<ComponentPropsWithoutRef<"section">, "title" | "children">) {
  const motion = useContentMotion<HTMLElement>(motionKey, "fade");
  return (
    <section {...attributes} ref={motion} className={`panel ${className}`}>
      {title && (
        <div className="panel-heading">
          <h2>{title}</h2>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <div className="loading-title">
        <LoaderCircle className="spin" size={15} /> Загружаем данные…
      </div>
      <div className="loading-skeleton" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}
export function ErrorNotice({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  if (!error) return null;
  return (
    <div className="error-notice" role="alert">
      <AlertCircle size={17} />
      <div>
        <strong>{errorText(error)}</strong>
        {error instanceof ApiError && error.fields.length > 0 && (
          <ul>
            {error.fields.map((f) => (
              <li key={f.path}>
                {f.path}: {f.message}
              </li>
            ))}
          </ul>
        )}
      </div>
      {onRetry && (
        <button className="button small" onClick={onRetry}>
          Повторить
        </button>
      )}
    </div>
  );
}
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  const id = useId();
  const describedBy =
    [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ") ||
    undefined;
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<Record<string, unknown>>, {
        "aria-labelledby": `${id}-label`,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : undefined,
      })
    : children;
  return (
    <label className="field">
      <span id={`${id}-label`}>{label}</span>
      {control}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
      {error && (
        <small id={`${id}-error`} className="bad" role="alert">
          {error}
        </small>
      )}
    </label>
  );
}
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={(v) => !v && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className="modal"
          onOpenAutoFocus={(event) => {
            returnFocus.current = document.activeElement as HTMLElement | null;
            const input = (
              event.target as HTMLElement
            ).querySelector<HTMLInputElement>("[data-initial-focus]");
            if (input) {
              event.preventDefault();
              input.focus();
            }
          }}
          onCloseAutoFocus={(event) => {
            if (returnFocus.current?.isConnected) {
              event.preventDefault();
              returnFocus.current.focus({ preventScroll: true });
            }
          }}
        >
          <div className="modal-title">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label="Закрыть">
              <X size={20} />
            </Dialog.Close>
          </div>
          <Dialog.Description className="muted">
            {description}
          </Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function CopyButton({
  value,
  label = "Копировать",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  return (
    <button
      className={`button small ${copied ? "is-copied" : ""}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setError(false);
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        } catch {
          setError(true);
        }
      }}
    >
      <span className="copy-icon" key={copied ? "copied" : "copy"}>
        {copied ? <CheckCircle2 size={14} /> : <Copy size={14} />}
      </span>
      {error ? "Выделите и скопируйте вручную" : copied ? "Скопировано" : label}
    </button>
  );
}
export function time(value: string | null | undefined, full = false) {
  if (!value) return "—";
  return new Date(value).toLocaleString(
    "ru-RU",
    full
      ? { dateStyle: "medium", timeStyle: "medium" }
      : {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        },
  );
}
export function age(value: string | null | undefined) {
  if (!value) return "Нет heartbeat";
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(value)) / 1000),
  );
  return seconds < 60
    ? `${seconds} с назад`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)} мин назад`
      : `${Math.floor(seconds / 3600)} ч назад`;
}
export function cleanText(value: unknown): string {
  return (
    typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "")
  )
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}
export function Code({ value }: { value: unknown }) {
  return <pre className="code">{cleanText(value)}</pre>;
}
export function KeyValue({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="key-value">
      <span>{label}</span>
      <div>{children}</div>
    </div>
  );
}
