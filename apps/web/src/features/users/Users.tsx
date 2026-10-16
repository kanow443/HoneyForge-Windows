import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api } from "../../shared/api/client";
import type { User } from "../../shared/api/models";
import { useAuth } from "../auth/Auth";
import {
  PermissionNote,
  roleDescriptions,
  roleLabels,
  usePermissions,
} from "../auth/permissions";
import type { Role } from "../auth/permissions";
import {
  ErrorNotice,
  Field,
  Loading,
  Modal,
  PageHeader,
} from "../../shared/ui";

const roles: Role[] = ["participant", "viewer", "analyst", "operator", "admin"];
export function UsersPage() {
  const auth = useAuth(),
    { can } = usePermissions(),
    client = useQueryClient();
  const [open, setOpen] = useState(false),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [role, setRole] = useState<Role>("viewer"),
    [target, setTarget] = useState<User | null>(null),
    [nextRole, setNextRole] = useState<Role>("viewer");
  const q = useQuery({
    queryKey: ["users"],
    queryFn: api.users,
    enabled: can("admin"),
    refetchInterval: 15000,
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ["users"] });
    void client.invalidateQueries({ queryKey: ["audit"] });
  };
  const create = useMutation({
    mutationFn: () =>
      api.createUser({ username: username.trim(), password, role }),
    onSuccess: () => {
      setOpen(false);
      setPassword("");
      setUsername("");
      refresh();
    },
  });
  const change = useMutation({
    mutationFn: () => api.userRole(target!.id, { role: nextRole }),
    onSuccess: (user) => {
      setTarget(null);
      refresh();
      if (user.id === auth.user?.id) {
        auth.setUser(null);
        client.clear();
      }
    },
  });
  const lastAdmin =
    target?.role === "admin" &&
    (q.data?.filter((u) => u.role === "admin").length ?? 0) <= 1;
  if (!can("admin")) return <PermissionNote permission="admin" />;
  function closeCreate() {
    if (!create.isPending) {
      setOpen(false);
      setPassword("");
      create.reset();
    }
  }
  return (
    <>
      <PageHeader
        title="Пользователи"
        description="Учётные записи и права доступа к HoneyForge."
        action={
          <button
            className="button primary"
            onClick={() => {
              setRole("viewer");
              setPassword("");
              create.reset();
              setOpen(true);
            }}
          >
            <Plus size={15} />
            Добавить пользователя
          </button>
        }
      />
      <ErrorNotice error={q.error} onRetry={() => q.refetch()} />
      {q.isPending ? (
        <Loading />
      ) : (
        q.data && (
          <div className="table-wrap users-table">
            <table>
              <thead>
                <tr>
                  <th>Пользователь</th>
                  <th>Роль</th>
                  <th>Доступ</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {q.data.map((user) => (
                  <tr key={user.id}>
                    <td>
                      {user.username}
                      {user.id === auth.user?.id && (
                        <small className="cell-sub">Ваша учётная запись</small>
                      )}
                    </td>
                    <td>{roleLabels[user.role]}</td>
                    <td>{roleDescriptions[user.role]}</td>
                    <td>
                      <button
                        className="button small"
                        onClick={() => {
                          setTarget(user);
                          setNextRole(user.role);
                          change.reset();
                        }}
                      >
                        Изменить роль
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
      <p className="permission-note">
        Изменение роли завершает активные сеансы пользователя. Последний
        администратор защищён от понижения роли.
      </p>
      <Modal
        open={open}
        onClose={closeCreate}
        title="Добавить пользователя"
        description="Новая учётная запись получает только выбранные права."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (can("admin")) create.mutate();
          }}
        >
          <Field
            label="Имя пользователя"
            hint="Латинские буквы, цифры и символы _ . @ -"
          >
            <input
              autoComplete="off"
              required
              maxLength={80}
              pattern="[A-Za-z0-9_.@\-]+"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={create.isPending}
            />
          </Field>
          <Field label="Пароль" hint="От 12 до 200 символов">
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={200}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={create.isPending}
            />
          </Field>
          <Field label="Роль">
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              disabled={create.isPending}
            >
              {roles.map((r) => (
                <option key={r} value={r}>
                  {roleLabels[r]}
                </option>
              ))}
            </select>
          </Field>
          <p className="permission-note">{roleDescriptions[role]}</p>
          <ErrorNotice error={create.error} />
          <div className="actions">
            <button
              type="button"
              className="button"
              disabled={create.isPending}
              onClick={closeCreate}
            >
              Отмена
            </button>
            <button
              className="button primary"
              disabled={
                create.isPending || !username.trim() || password.length < 12
              }
            >
              {create.isPending ? "Создаём…" : "Создать пользователя"}
            </button>
          </div>
        </form>
      </Modal>
      <Modal
        open={Boolean(target)}
        onClose={() => {
          if (!change.isPending) setTarget(null);
        }}
        title={`Изменить роль ${target?.username ?? ""}`}
        description="Все активные сеансы этой учётной записи завершатся. Пользователь должен войти заново."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (can("admin") && !(lastAdmin && nextRole !== "admin"))
              change.mutate();
          }}
        >
          <Field label="Новая роль">
            <select
              value={nextRole}
              disabled={change.isPending}
              onChange={(e) => setNextRole(e.target.value as Role)}
            >
              {roles.map((r) => (
                <option key={r} value={r} disabled={lastAdmin && r !== "admin"}>
                  {roleLabels[r]}
                </option>
              ))}
            </select>
          </Field>
          <p className="permission-note">{roleDescriptions[nextRole]}</p>
          {lastAdmin && (
            <p className="permission-note">
              Это последний администратор. Сначала назначьте другого
              администратора.
            </p>
          )}
          {target?.id === auth.user?.id && (
            <p className="permission-note">
              Вы изменяете собственную роль. После сохранения потребуется
              повторный вход.
            </p>
          )}
          <ErrorNotice error={change.error} />
          <div className="actions">
            <button
              type="button"
              className="button"
              disabled={change.isPending}
              onClick={() => setTarget(null)}
            >
              Отмена
            </button>
            <button
              className="button primary"
              disabled={
                change.isPending ||
                nextRole === target?.role ||
                (lastAdmin && nextRole !== "admin")
              }
            >
              {change.isPending ? "Сохраняем…" : "Сохранить роль"}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
