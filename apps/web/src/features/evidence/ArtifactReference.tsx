import { Link } from "react-router-dom";
import type { Event } from "../../shared/api/models";

export function ArtifactReference({ event }: { event: Event }) {
  if (!event.event_type.startsWith("ssh.file.")) return null;
  const id = event.payload.artifact_id;
  if (
    typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    return (
      <p className="artifact-reference">
        <Link
          to={
            event.session_id
              ? `/sessions/${event.session_id}?artifact=${encodeURIComponent(id)}`
              : `/traps/${event.deployment_id}?artifact=${encodeURIComponent(id)}#evidence`
          }
        >
          Проверить сохранённый файл
        </Link>
        <span>Доступность содержимого указана в разделе «Доказательства».</span>
      </p>
    );
  if (event.payload.artifact_capture === "unavailable")
    return (
      <p className="artifact-reference">
        Сенсор не сохранил содержимое файла. Доступно только событие.
      </p>
    );
  return null;
}
