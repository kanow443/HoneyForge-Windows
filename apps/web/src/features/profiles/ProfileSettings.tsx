import type { Config, ConfigV2 } from "../../shared/api/models";
import { Field } from "../../shared/ui";
export function ProfileSettings({
  config,
  patch,
  errors,
  endGroup,
  showPort = true,
}: {
  config: ConfigV2;
  patch: (next: Partial<Config>, group?: string) => void;
  errors: Record<string, string>;
  endGroup: () => void;
  showPort?: boolean;
}) {
  const accounts = config.decoy_accounts ?? [
      { username: "demo.user", password: "hackathon-demo" },
    ],
    recording = config.recording ?? {
      capture_credentials: true,
      http_payload_bytes: 8192,
      shell_output_bytes: 262144,
    },
    beacon = config.beacon ?? { interval_seconds: 5, jitter_ratio: 0.2 };
  return (
    <div className="studio-profile-settings">
      {showPort && (
        <Field
          label="Рекомендуемый порт"
          error={errors.recommended_port}
          hint="Порт по умолчанию при развёртывании; сам по себе сервис не запускает."
        >
          <input
            type="number"
            min={1024}
            max={65535}
            step={1}
            value={config.recommended_port}
            onChange={(e) =>
              patch(
                { recommended_port: Number(e.target.value) },
                "recommended_port",
              )
            }
            onBlur={endGroup}
          />
        </Field>
      )}
      {config.adapter !== "tcp-banner" && (
        <details
          open={
            Object.keys(errors).some((k) => k.startsWith("account")) ||
            undefined
          }
        >
          <summary>Учётные записи-приманки</summary>
          <p className="permission-note">
            Только синтетические данные. Не используйте действующие пароли. Это
            доступ к приманке, а не к панели управления.
          </p>
          {accounts.map((account, i) => (
            <div className="studio-decoy-account" key={i}>
              <Field
                label={`Логин приманки ${i + 1}`}
                error={errors[`account.${i}.username`]}
              >
                <input
                  autoComplete="off"
                  maxLength={64}
                  value={account.username}
                  onChange={(e) =>
                    patch(
                      {
                        decoy_accounts: accounts.map((a, j) =>
                          j === i ? { ...a, username: e.target.value } : a,
                        ),
                      },
                      `account.${i}.username`,
                    )
                  }
                  onBlur={endGroup}
                />
              </Field>
              <Field
                label={`Пароль приманки ${i + 1}`}
                error={errors[`account.${i}.password`]}
                hint="8–128 символов: латиница, цифры, _ . @ -"
              >
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={128}
                  value={account.password}
                  onChange={(e) =>
                    patch(
                      {
                        decoy_accounts: accounts.map((a, j) =>
                          j === i ? { ...a, password: e.target.value } : a,
                        ),
                      },
                      `account.${i}.password`,
                    )
                  }
                  onBlur={endGroup}
                />
              </Field>
              <button
                className="button small"
                type="button"
                disabled={accounts.length <= 1}
                onClick={() =>
                  patch({ decoy_accounts: accounts.filter((_, j) => j !== i) })
                }
                aria-label={`Удалить учётную запись-приманку ${i + 1}`}
              >
                Убрать
              </button>
            </div>
          ))}
          <button
            type="button"
            className="button small"
            disabled={accounts.length >= 8}
            onClick={() =>
              patch({
                decoy_accounts: [...accounts, { username: "", password: "" }],
              })
            }
          >
            Добавить учётную запись-приманку
          </button>
        </details>
      )}
      {config.adapter !== "tcp-banner" && (
        <details
          open={
            Boolean(errors.http_payload_bytes || errors.shell_output_bytes) ||
            undefined
          }
        >
          <summary>Запись взаимодействия</summary>
          <label className="studio-recording-choice">
            <input
              type="checkbox"
              checked={recording.capture_credentials}
              onChange={(e) =>
                patch({
                  recording: {
                    ...recording,
                    capture_credentials: e.target.checked,
                  },
                })
              }
            />
            Сохранять введённые учётные данные
          </label>
          <p className="permission-note">
            Параметры сбора применяются после развёртывания этой версии. Доступ
            к сохранённым секретам контролируется отдельно от событий.
          </p>
          {config.adapter === "http" ? (
            <Field
              label="Лимит HTTP payload, байт"
              error={errors.http_payload_bytes}
              hint="0 отключает запись тела, максимум 8192 байта."
            >
              <input
                type="number"
                min={0}
                max={8192}
                step={1}
                value={recording.http_payload_bytes}
                onChange={(e) =>
                  patch(
                    {
                      recording: {
                        ...recording,
                        http_payload_bytes: Number(e.target.value),
                      },
                    },
                    "http_payload_bytes",
                  )
                }
                onBlur={endGroup}
              />
            </Field>
          ) : (
            <Field
              label="Лимит вывода SSH, байт"
              error={errors.shell_output_bytes}
              hint="От 16384 до 1048576 байт на канал."
            >
              <input
                type="number"
                min={16384}
                max={1048576}
                step={1}
                value={recording.shell_output_bytes}
                onChange={(e) =>
                  patch(
                    {
                      recording: {
                        ...recording,
                        shell_output_bytes: Number(e.target.value),
                      },
                    },
                    "shell_output_bytes",
                  )
                }
                onBlur={endGroup}
              />
            </Field>
          )}
        </details>
      )}
      <details
        open={
          Boolean(errors.interval_seconds || errors.jitter_ratio) || undefined
        }
      >
        <summary>Связь с центром</summary>
        <p className="permission-note">
          Интервал и разброс запросов агента. Эти параметры не подтверждают
          скрытность канала или доступность центра.
        </p>
        <Field label="Интервал связи, секунд" error={errors.interval_seconds}>
          <input
            type="number"
            min={1}
            max={60}
            step={0.1}
            value={beacon.interval_seconds}
            onChange={(e) =>
              patch(
                {
                  beacon: {
                    ...beacon,
                    interval_seconds: Number(e.target.value),
                  },
                },
                "interval_seconds",
              )
            }
            onBlur={endGroup}
          />
        </Field>
        <Field
          label="Разброс интервала"
          error={errors.jitter_ratio}
          hint="От 0,1 до 0,5; 0,2 соответствует 20%."
        >
          <input
            type="number"
            min={0.1}
            max={0.5}
            step={0.1}
            value={beacon.jitter_ratio}
            onChange={(e) =>
              patch(
                { beacon: { ...beacon, jitter_ratio: Number(e.target.value) } },
                "jitter_ratio",
              )
            }
            onBlur={endGroup}
          />
        </Field>
      </details>
    </div>
  );
}
