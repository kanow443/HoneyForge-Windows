import type { SourceBlock } from "../../shared/api/models";
// A cached response from an older API must not imply successful termination.
export type TerminationDetails = Partial<
  Pick<
    SourceBlock,
    | "terminate_sessions"
    | "termination_state"
    | "terminated_sessions"
    | "termination_error"
  >
>;
export function TerminationResult({ block }: { block: TerminationDetails }) {
  if (block.terminate_sessions === undefined) return null;
  const state = block.termination_state;
  const ids = [...new Set(block.terminated_sessions ?? [])];
  const message =
    state === "completed"
      ? ids.length
        ? `Агент подтвердил завершение SSH-сессий: ${ids.length}.`
        : "Агент проверил завершение: открытых SSH-сессий не найдено."
      : state === "pending"
        ? "Ожидаем подтверждение завершения SSH-сессий."
        : state === "unsupported"
          ? "Этот запуск сенсора не поддерживает завершение открытых SSH-сессий."
          : state === "error"
            ? "Не удалось подтвердить завершение SSH-сессий."
            : state === "not_requested"
              ? "Завершение SSH-сессий не запрашивалось."
              : "Сведения о завершении SSH-сессий недоступны.";
  return (
    <div className={`termination-result termination-${state ?? "unknown"}`}>
      <strong>Открытые SSH-сессии</strong>
      <p role="status">{message}</p>
      {block.termination_error && (
        <p className="bad">{block.termination_error}</p>
      )}
      {ids.length > 0 && (
        <details>
          <summary>Идентификаторы транспортных сессий ({ids.length})</summary>
          <ul>
            {ids.map((id) => (
              <li key={id}>
                <code>{id}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      {block.terminate_sessions && (
        <small>
          Отмена ограничения разрешает новые подключения, но не восстанавливает
          завершённые сессии.
        </small>
      )}
    </div>
  );
}
