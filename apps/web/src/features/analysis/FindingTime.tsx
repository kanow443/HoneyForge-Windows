import type { components } from "../../shared/api/generated";
import { time } from "../../shared/ui";
type Finding = Pick<
  components["schemas"]["FindingView"],
  "notification_state" | "observed_first_at" | "observed_last_at"
>;
export function FindingTime({ finding }: { finding: Finding }) {
  if (!finding.observed_first_at && finding.notification_state !== "historical")
    return null;
  return (
    <small className="finding-observation-time">
      {finding.notification_state === "historical"
        ? "Историческое срабатывание · без LIVE-тревоги"
        : "Время наблюдения"}
      {finding.observed_first_at && (
        <span>
          {time(finding.observed_first_at, true)}
          {finding.observed_last_at &&
          finding.observed_last_at !== finding.observed_first_at
            ? " — " + time(finding.observed_last_at, true)
            : ""}
        </span>
      )}
    </small>
  );
}
