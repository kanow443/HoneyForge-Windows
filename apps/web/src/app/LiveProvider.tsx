import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../shared/api/client";
import { useAuth } from "../features/auth/Auth";
type Live = {
  status: "connecting" | "connected" | "reconnecting" | "offline";
  reset: number;
  eventRevision: number;
};
const Context = createContext<Live>({
  status: "connecting",
  reset: 0,
  eventRevision: 0,
});
export function useLive() {
  return useContext(Context);
}
export function LiveProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth(),
    client = useQueryClient();
  const [status, setStatus] = useState<Live["status"]>("connecting"),
    [reset, setReset] = useState(0),
    [eventRevision, setEventRevision] = useState(0);
  useEffect(() => {
    if (!user || user.role === "participant") return;
    let stream: EventSource | undefined,
      timer: ReturnType<typeof setTimeout> | undefined,
      retry: ReturnType<typeof setTimeout> | undefined,
      disposed = false;
    const dirty = new Set<string>();
    let eventDirty = false;
    const flush = () => {
      for (const key of dirty)
        void client.invalidateQueries(
          { queryKey: [key] },
          { cancelRefetch: false },
        );
      dirty.clear();
      if (eventDirty) {
        setEventRevision((n) => n + 1);
        eventDirty = false;
      }
      timer = undefined;
    };
    const start = async () => {
      try {
        const snapshot = await api.events({ limit: 1 });
        if (disposed) return;
        stream = new EventSource(`/api/v1/stream?after=${snapshot.watermark}`, {
          withCredentials: true,
        });
        stream.onopen = () => {
          setStatus("connected");
          [
            "events",
            "playback",
            "session",
            "sessions",
            "topology",
            "blocks",
            "cases",
            "report",
            "artifacts",
          ].forEach(
            (key) => void client.invalidateQueries({ queryKey: [key] }),
          );
        };
        stream.onerror = () => {
          setStatus(navigator.onLine ? "reconnecting" : "offline");
          void api.me().catch(() => {});
        };
        stream.addEventListener("update", (e) => {
          try {
            const update = JSON.parse((e as MessageEvent).data);
            const kind = update.kind as string;
            dirty.add("overview");
            dirty.add("groups");
            dirty.add("group");
            ["topology", "blocks", "cases", "report"].forEach((k) =>
              dirty.add(k),
            );
            if (kind.startsWith("flag.")) {
              dirty.add("flag-challenges");
              dirty.add("flag-scoreboard");
            } else if (kind.startsWith("event")) {
              eventDirty = true;
              ["events", "sessions", "session", "findings", "playback"].forEach(
                (k) => dirty.add(k),
              );
              dirty.add("geo-sources");
            } else if (kind.startsWith("honeytoken")) {
              dirty.add("honeytokens");
              dirty.add("findings");
            } else if (kind.startsWith("detection")) {
              dirty.add("detection-policy");
            } else if (kind.includes("certificate")) {
              dirty.add("certificates");
            } else if (kind === "artifact.changed") {
              dirty.add("artifacts");
            } else if (kind.startsWith("host")) {
              dirty.add("hosts");
              dirty.add("certificates");
              dirty.add("deployments");
              dirty.add("deployment");
            } else if (kind.startsWith("profile")) {
              dirty.add("profiles");
              dirty.add("profile");
            } else {
              dirty.add("deployments");
              dirty.add("deployment");
            }
            if (!timer) timer = setTimeout(flush, 350);
          } catch {
            /* A malformed update cannot corrupt the snapshot. */
          }
        });
        stream.addEventListener("reset_required", () => {
          setReset((n) => n + 1);
          setEventRevision((n) => n + 1);
          void client.invalidateQueries();
        });
        stream.addEventListener("auth_expired", () => {
          stream?.close();
          window.dispatchEvent(new CustomEvent("auth-expired"));
        });
      } catch {
        if (!disposed) {
          setStatus(navigator.onLine ? "reconnecting" : "offline");
          retry = setTimeout(start, 5000);
        }
      }
    };
    void start();
    const online = () => setStatus("reconnecting"),
      offline = () => setStatus("offline");
    const expired = () => stream?.close();
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    window.addEventListener("auth-expired", expired);
    return () => {
      disposed = true;
      stream?.close();
      clearTimeout(timer);
      clearTimeout(retry);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      window.removeEventListener("auth-expired", expired);
    };
  }, [user, client]);
  return (
    <Context.Provider value={{ status, reset, eventRevision }}>
      {children}
    </Context.Provider>
  );
}
export function LiveStatus({
  onlyProblems = false,
}: {
  onlyProblems?: boolean;
}) {
  const { status } = useLive();
  if (onlyProblems && ["connected", "connecting"].includes(status)) return null;
  return (
    <span className={`live-status ${status === "connected" ? "good" : "warn"}`}>
      {
        {
          connected: "Связь с сервером установлена",
          connecting: "Подключаемся к серверу…",
          reconnecting: "Восстанавливаем связь с сервером",
          offline: "Нет сети",
        }[status]
      }
    </span>
  );
}
