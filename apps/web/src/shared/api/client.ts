import type { components } from "./generated";
import type {
  Audit,
  Deployment,
  EventPage,
  Event,
  Filters,
  Finding,
  Host,
  Overview,
  Profile,
  ProfileVersion,
  Session,
  SessionDetail,
  User,
  PlaybackPage,
  Topology,
  SourceBlock,
  InvestigationCase,
  SessionReport,
  Artifact,
  IntegrationToken,
  DeploymentGroup,
  FlagChallenge,
  FlagScore,
} from "./models";
let csrfToken = "";
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields: { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = "ApiError";
  }
}
export function csrfCookie() {
  return typeof document === "undefined"
    ? ""
    : decodeURIComponent(
        document.cookie
          .split("; ")
          .find((c) => c.startsWith("hf_csrf="))
          ?.slice(8) ?? "",
      );
}
export function queryString(filters: Filters) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  });
  return params.toString();
}
export async function request<T>(
  path: string,
  options: {
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    captureBody?: (body: string) => void;
  } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method: options.body !== undefined ? "POST" : "GET",
      credentials: "include",
      signal: options.signal,
      headers: {
        ...(options.body !== undefined
          ? {
              "Content-Type": "application/json",
              "X-CSRF-Token": csrfCookie() || csrfToken,
            }
          : {}),
        ...options.headers,
      },
      body:
        options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ApiError(
      0,
      "unavailable",
      "Нет связи с сервером. Проверьте подключение и повторите запрос.",
    );
  }
  const raw = await response.text();
  options.captureBody?.(raw);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }
  if (!response.ok) {
    if (response.status === 401 && path !== "/auth/login") {
      csrfToken = "";
      window.dispatchEvent(new CustomEvent("auth-expired"));
    }
    throw new ApiError(
      response.status,
      data?.error?.code ?? "request_failed",
      data?.error?.message ?? "Сервер не смог выполнить запрос",
      data?.error?.fields ?? [],
    );
  }
  return data as T;
}
export const api = {
  me: () => request<User>("/auth/me"),
  users: () => request<User[]>("/users"),
  createUser: (body: components["schemas"]["CreateUser"]) =>
    request<User>("/users", { body }),
  userRole: (id: string, body: components["schemas"]["ChangeUserRole"]) =>
    request<User>(`/users/${encodeURIComponent(id)}/role`, { body }),
  integrationTokens: () => request<IntegrationToken[]>("/integration-tokens"),
  createIntegrationToken: (
    body: components["schemas"]["CreateIntegrationToken"],
  ) =>
    request<components["schemas"]["IntegrationTokenSecret"]>(
      "/integration-tokens",
      { body },
    ),
  revokeIntegrationToken: (id: string) =>
    request<IntegrationToken>(
      `/integration-tokens/${encodeURIComponent(id)}/revoke`,
      { body: {} },
    ),
  login: async (body: components["schemas"]["Login"]) => {
    const data = await request<components["schemas"]["LoginView"]>(
      "/auth/login",
      { body },
    );
    csrfToken = data.csrf_token;
    return data.user;
  },
  logout: async () => {
    await request("/auth/logout", { body: {} });
    csrfToken = "";
  },
  overview: () => request<Overview>("/overview"),
  hosts: () => request<Host[]>("/hosts"),
  enrollment: () =>
    request<components["schemas"]["EnrollmentView"]>(
      "/hosts/enrollment-tokens",
      {
        body: {},
      },
    ),
  revoke: (id: string) => request<Host>(`/hosts/${id}/revoke`, { body: {} }),
  profiles: () => request<Profile[]>("/profiles"),
  profile: (id: string) => request<Profile>(`/profiles/${id}`),
  createProfile: (body: components["schemas"]["CreateProfile"]) =>
    request<Profile>("/profiles", { body }),
  profileMetadata: (id: string, body: components["schemas"]["UpdateProfile"]) =>
    request<Profile>(`/profiles/${encodeURIComponent(id)}/metadata`, { body }),
  profileLifecycle: (id: string, action: "archive" | "restore") =>
    request<Profile>(`/profiles/${encodeURIComponent(id)}/${action}`, {
      body: {},
    }),
  deleteProfile: (id: string) =>
    request<components["schemas"]["OkayView"]>(
      `/profiles/${encodeURIComponent(id)}/delete`,
      { body: {} },
    ),
  version: (id: string, body: components["schemas"]["PublishVersion"]) =>
    request<ProfileVersion>(`/profiles/${id}/versions`, { body }),
  deployments: () => request<Deployment[]>("/deployments"),
  groups: () => request<DeploymentGroup[]>("/deployment-groups"),
  group: (id: string) =>
    request<DeploymentGroup>(`/deployment-groups/${encodeURIComponent(id)}`),
  deployGroup: (body: components["schemas"]["DeployGroup"], key: string) =>
    request<DeploymentGroup>("/deployment-groups", {
      body,
      headers: { "Idempotency-Key": key },
    }),
  stopGroup: (id: string) =>
    request<DeploymentGroup>(
      `/deployment-groups/${encodeURIComponent(id)}/stop`,
      { body: {} },
    ),
  redeployGroup: (id: string, version?: string) =>
    request<DeploymentGroup>(
      `/deployment-groups/${encodeURIComponent(id)}/redeploy`,
      { body: version ? { profile_version_id: version } : {} },
    ),
  deployment: (id: string) => request<Deployment>(`/deployments/${id}`),
  deploy: (body: components["schemas"]["Deploy"], key: string) =>
    request<Deployment>("/deployments", {
      body,
      headers: { "Idempotency-Key": key },
    }),
  stop: (id: string) =>
    request<Deployment>(`/deployments/${id}/stop`, { body: {} }),
  redeploy: (id: string, version?: string) =>
    request<Deployment>(`/deployments/${id}/redeploy`, {
      body: version ? { profile_version_id: version } : {},
    }),
  events: (filters: Filters = {}, signal?: AbortSignal) =>
    request<EventPage>(`/events?${queryString(filters)}`, { signal }),
  setEventFlag: (id: string, body: { flag: "suspicious" | "reviewed" | "false_positive" | "escalated"; enabled: boolean; note: string }) =>
    request<Event>(`/events/${encodeURIComponent(id)}/flags`, { body }),
  flagChallenges: () => request<FlagChallenge[]>("/flags/challenges"),
  adminFlagChallenges: () => request<FlagChallenge[]>("/flags/admin/challenges"),
  createFlagChallenge: (body: { binding_id: string; title: string; points: number }) =>
    request<FlagChallenge>("/flags/challenges", { body }),
  setFlagChallenge: (id: string, enabled: boolean) =>
    request<FlagChallenge>(`/flags/challenges/${encodeURIComponent(id)}/state`, { body: { enabled } }),
  submitFlag: (challenge_id: string, flag: string) =>
    request<{ ok: boolean; points: number; challenge_id: string }>("/flags/submit", { body: { challenge_id, flag } }),
  flagScoreboard: () => request<FlagScore[]>("/flags/scoreboard"),
  sessions: (id?: string) =>
    request<Session[]>(`/sessions${id ? `?deployment_id=${id}` : ""}`),
  session: (id: string) => request<SessionDetail>(`/sessions/${id}`),
  playback: (id: string, after = 0, signal?: AbortSignal) =>
    request<PlaybackPage>(`/sessions/${id}/playback?after=${after}&limit=500`, {
      signal,
    }),
  topology: (hours = 24) => request<Topology>(`/topology?hours=${hours}`),
  blocks: (deployment: string) =>
    request<SourceBlock[]>(
      `/source-blocks?deployment_id=${encodeURIComponent(deployment)}`,
    ),
  block: (body: components["schemas"]["CreateSourceBlock"], key: string) =>
    request<SourceBlock>("/source-blocks", {
      body,
      headers: { "Idempotency-Key": key },
    }),
  cancelBlock: (id: string, revision: number) =>
    request<SourceBlock>(`/source-blocks/${id}/cancel`, { body: { revision } }),
  cases: () => request<InvestigationCase[]>("/cases"),
  createCase: (body: { title: string; session_ids: string[]; note: string }) =>
    request<InvestigationCase>("/cases", { body }),
  updateCase: (
    id: string,
    body: {
      revision: number;
      status: InvestigationCase["status"];
      note: string;
    },
  ) => request<InvestigationCase>(`/cases/${id}`, { body }),
  caseRetention: (id: string, body: components["schemas"]["PinCase"]) =>
    request<InvestigationCase>(`/cases/${encodeURIComponent(id)}/retention`, {
      body,
    }),
  storage: () => request<components["schemas"]["StorageView"]>("/storage"),
  honeytokens: (profileId: string) =>
    request<components["schemas"]["HoneyTokenView"][]>(
      "/honeytokens?profile_id=" + encodeURIComponent(profileId),
    ),
  createHoneytoken: (body: components["schemas"]["CreateHoneyToken"]) =>
    request<components["schemas"]["HoneyTokenView"]>("/honeytokens", { body }),
  revokeHoneytoken: (id: string) =>
    request<components["schemas"]["HoneyTokenView"]>(
      "/honeytokens/" + encodeURIComponent(id) + "/revoke",
      { body: {} },
    ),
  detectionPolicy: () =>
    request<components["schemas"]["DetectionPolicyView"]>("/detection-policy"),
  updateDetectionPolicy: (
    body: components["schemas"]["UpdateDetectionPolicy"],
  ) =>
    request<components["schemas"]["DetectionPolicyView"]>("/detection-policy", {
      body,
    }),
  iocExport: (body: components["schemas"]["IoCExportRequest"]) =>
    request<components["schemas"]["IoCExportView"]>("/ioc-exports", { body }),
  geoSources: () =>
    request<components["schemas"]["GeoTopView"]>("/geo-sources"),
  hostCertificates: (id: string) =>
    request<components["schemas"]["AgentCertificateView"][]>(
      "/hosts/" + encodeURIComponent(id) + "/certificates",
    ),
  revokeCertificate: (id: string) =>
    request<components["schemas"]["AgentCertificateView"]>(
      "/agent-certificates/" + encodeURIComponent(id) + "/revoke",
      { body: {} },
    ),
  privateCapture: (id: string) =>
    request<components["schemas"]["PrivateCaptureView"]>(
      `/events/${encodeURIComponent(id)}/private-capture`,
      { body: {} },
    ),
  report: async (id: string) => {
    let raw = "";
    const document = await request<SessionReport>(`/sessions/${id}/report`, {
      captureBody: (body) => {
        raw = body;
      },
    });
    return { document, raw };
  },
  artifacts: (
    scope: { deployment_id: string } | { session_id: string },
    signal?: AbortSignal,
  ) =>
    request<Artifact[]>(`/artifacts?${new URLSearchParams(scope)}`, { signal }),
  artifactBytes: async (id: string, signal?: AbortSignal) => {
    let response: Response;
    try {
      response = await fetch(
        `/api/v1/artifacts/${encodeURIComponent(id)}/download`,
        {
          credentials: "include",
          signal,
        },
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ApiError(
        0,
        "unavailable",
        "Нет связи с сервером. Повторите скачивание.",
      );
    }
    if (!response.ok) {
      if (response.status === 401) {
        csrfToken = "";
        window.dispatchEvent(new CustomEvent("auth-expired"));
      }
      const data = await response.json().catch(() => null);
      throw new ApiError(
        response.status,
        data?.error?.code ?? "request_failed",
        data?.error?.message ?? "Не удалось получить содержимое доказательства",
      );
    }
    return {
      bytes: await response.arrayBuffer(),
      sha256: response.headers.get("X-Content-SHA256"),
    };
  },
  findings: () => request<Finding[]>("/findings"),
  audit: () => request<Audit[]>("/audit"),
  export: (body: { session_id?: string; filters: Filters }) =>
    request<components["schemas"]["ExportView"]>("/exports", { body }),
};
export function errorText(error: unknown) {
  if (error instanceof ApiError) {
    const specific: Record<string, string> = {
      capture_unavailable:
        "Для этого события нет сохранённых закрытых данных или срок хранения истёк.",
      capture_key_unavailable:
        "Ключ расшифровки недоступен. Содержимое не раскрыто.",
      permission_denied: "Ваша роль не разрешает это действие.",
      integration_quota:
        "Достигнут предел действующих ключей. Отзовите ненужные ключи и повторите запрос.",
      profile_in_use:
        "У профиля есть история развёртываний. Его можно архивировать, сохранив работающие ловушки; удаление недоступно.",
      profile_archived:
        "Профиль в архиве. Восстановите его перед публикацией или развёртыванием.",
      unsupported_adapter:
        "Этот тип маркера не поддерживается выбранным протоколом.",
      token_limit:
        "У этой версии уже 8 активных маркеров. Отзовите ненужный маркер.",
      path_conflict:
        "Этот путь уже занят файлом профиля или другим активным маркером. Выберите отдельный путь.",
      username_exists: "Это имя пользователя уже занято.",
      last_admin:
        "Нельзя понизить роль последнего администратора. Сначала назначьте другого администратора.",
      unobserved_source:
        "Этот IP ещё не наблюдался в текущем запуске. Выберите источник из сохранённой сессии.",
      protected_source: "Защищённый адрес управления нельзя заблокировать.",
      runtime_unavailable:
        "Для ограничения нужен подтверждённый работающий запуск ловушки.",
      already_blocked:
        "Для этого источника уже действует ограничение. Откройте его в списке.",
      stale_revision:
        "Состояние изменилось. Загрузите актуальную версию перед повторным действием.",
      policy_limit:
        "Достигнут предел политик. Сначала отмените ненужные ограничения.",
      artifact_unavailable:
        "Содержимое ещё не принято или срок хранения истёк. Обновите список доказательств.",
    };
    if (specific[error.code]) return specific[error.code];
    if (error.status === 401) return "Неверное имя пользователя или пароль.";
    if (error.status === 403)
      return "Запрос отклонён: проверьте права или войдите снова для обновления защиты сессии.";
    if (error.status === 409) return `Действие отклонено. ${error.message}`;
    if (error.status === 422)
      return "Проверьте поля формы: сервер отклонил конфигурацию.";
    if (error.status === 429)
      return "Слишком много попыток. Подождите и попробуйте снова.";
  }
  return error instanceof Error
    ? error.message
    : "Не удалось выполнить действие.";
}
export async function downloadExport(body: {
  session_id?: string;
  filters: Filters;
}) {
  const data = await api.export(body);
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `honeyforge-${body.session_id ?? "events"}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
