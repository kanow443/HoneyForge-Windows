import type { ReactNode } from "react";
import { useAuth } from "./Auth";
import type { User } from "../../shared/api/models";

export type Permission = "operate" | "investigate" | "admin";
export type Role = User["role"];
export const roleLabels: Record<Role, string> = {
  admin: "Администратор",
  operator: "Оператор",
  analyst: "Аналитик",
  viewer: "Наблюдатель",
  participant: "Участник CTF",
};
export const roleDescriptions: Record<Role, string> = {
  viewer:
    "Просмотр экранов и метаданных. Без изменений, экспорта и скачивания файлов.",
  analyst:
    "Расследования, дела, экспорт и доказательства. Без управления ловушками и доступом.",
  operator:
    "Профили, ловушки, ограничения и расследования. Без управления хостами и пользователями.",
  admin:
    "Все действия, включая подключение хостов, управление пользователями и интеграциями.",
  participant:
    "Просмотр CTF-заданий, отправка флагов и таблица результатов. Без доступа к телеметрии и управлению.",
};
export function canAccess(role: string | undefined, permission: Permission) {
  return permission === "admin"
    ? role === "admin"
    : permission === "operate"
      ? role === "admin" || role === "operator"
      : role === "admin" || role === "operator" || role === "analyst";
}
export function usePermissions() {
  const role = useAuth()?.user?.role;
  return { role, can: (permission: Permission) => canAccess(role, permission) };
}
export function PermissionNote({ permission }: { permission: Permission }) {
  const { can } = usePermissions();
  if (can(permission)) return null;
  return (
    <p className="permission-note">
      {permission === "admin"
        ? "Для управления хостами, пользователями и интеграциями нужна роль администратора."
        : permission === "operate"
          ? "Управление профилями, ловушками и ограничениями доступно оператору и администратору."
          : "Изменение дел, экспорт и скачивание доступны аналитику, оператору и администратору."}
    </p>
  );
}
export function RequirePermission({
  permission,
  children,
}: {
  permission: Permission;
  children: ReactNode;
}) {
  const { can } = usePermissions();
  return can(permission) ? (
    children
  ) : (
    <section className="access-denied">
      <h1>Действие недоступно</h1>
      <PermissionNote permission={permission} />
    </section>
  );
}
