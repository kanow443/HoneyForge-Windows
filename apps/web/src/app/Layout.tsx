import {
  NavLink,
  Outlet,
  Link,
  useLocation,
  useNavigate,
  Navigate,
} from "react-router-dom";
import {
  Activity,
  Box,
  FileClock,
  Layers3,
  LayoutDashboard,
  LogOut,
  Search,
  Server,
  ArrowUpRight,
  Plus,
  Users,
  Plug,
  HardDrive,
  Flag,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth } from "../features/auth/Auth";
import {
  roleLabels,
  roleDescriptions,
  usePermissions,
} from "../features/auth/permissions";
import { ErrorNotice, Logo, Modal } from "../shared/ui";
import { LiveStatus } from "./LiveProvider";
import { MotionIndicator, useContentMotion } from "../shared/ui/motion";
const menu = [
  { to: "/", label: "Сеть ловушек", icon: LayoutDashboard, section: "Обзор" },
  {
    to: "/traps",
    label: "Развёртывания",
    icon: Box,
    section: "Инфраструктура",
  },
  { to: "/events", label: "События", icon: Activity, section: "Расследование" },
  { to: "/flags", label: "CTF-флаги", icon: Flag, section: "Задания" },
  { to: "/cases", label: "Дела", icon: FileClock, section: "Расследование" },
  { to: "/profiles", label: "Профили", icon: Layers3, section: "Конфигурация" },
  { to: "/hosts", label: "Хосты", icon: Server, section: "Инфраструктура" },
  { to: "/storage", label: "Хранилище", icon: HardDrive, section: "Данные" },
  {
    to: "/audit",
    label: "Журнал оператора",
    icon: FileClock,
    section: "История",
  },
  { to: "/users", label: "Пользователи", icon: Users, section: "Доступ" },
  { to: "/integrations", label: "Интеграции", icon: Plug, section: "Доступ" },
];
const commands = [
  ...menu,
  {
    to: "/traps/new",
    label: "Развернуть ловушку",
    icon: Plus,
    section: "Действие",
  },
  {
    to: "/profiles/new",
    label: "Создать профиль",
    icon: Plus,
    section: "Действие",
  },
];
export function Layout() {
  const { role, can } = usePermissions();
  const visibleMenu = menu.filter(
    (m) => role === "participant" ? m.to === "/flags" : (!["/users", "/integrations"].includes(m.to) || can("admin")),
  );
  const { user, logout } = useAuth(),
    location = useLocation(),
    navigate = useNavigate();
  const [error, setError] = useState<unknown>(null),
    [search, setSearch] = useState(false),
    [term, setTerm] = useState(""),
    [cursor, setCursor] = useState(0);
  const matches = commands.filter(
    (c) =>
      (role === "participant" ? c.to === "/flags" : (!["/users", "/integrations"].includes(c.to) || can("admin"))) &&
      (!["/profiles/new", "/traps/new"].includes(c.to) || can("operate")) &&
      `${c.label} ${c.section}`.toLowerCase().includes(term.toLowerCase()),
  );
  const section =
    menu.find((m) =>
      m.to === "/"
        ? location.pathname === "/"
        : location.pathname.startsWith(m.to),
    )?.section ?? "Расследование";
  const workspaceMotion = useContentMotion<HTMLElement>(
    location.pathname,
    "fade",
  );
  useEffect(() => {
    function shortcut(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearch((v) => !v);
        setTerm("");
        setCursor(0);
      }
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  function go(to: string) {
    setSearch(false);
    navigate(to);
  }
  if (role === "participant" && location.pathname !== "/flags") return <Navigate to="/flags" replace />;
  return (
    <div className="app-shell">
      <a className="skip-link" href="#workspace">
        К содержимому
      </a>
      <header className="console-header">
        <div className="console-masthead">
          <Link to="/" className="console-brand">
            <Logo />
          </Link>
          <div className="console-controls">
            <button
              className="command-trigger"
              onClick={() => {
                setSearch(true);
                setTerm("");
                setCursor(0);
              }}
            >
              <Search size={14} />
              <span>Перейти к…</span>
              <kbd>⌘ K</kbd>
            </button>
            <LiveStatus onlyProblems />
            <div className="console-user">
              <span>{user?.username}</span>
              <span
                className="role-badge"
                title={role ? roleDescriptions[role] : undefined}
              >
                {role ? roleLabels[role] : "Роль не получена"}
              </span>
              <button
                className="icon-button"
                aria-label="Выйти"
                onClick={() => logout().catch(setError)}
              >
                <LogOut size={15} />
              </button>
            </div>
          </div>
        </div>
        <nav className="console-nav" aria-label="Основная навигация">
          <MotionIndicator active={location.pathname} />
          {visibleMenu.map((m) => (
            <NavLink key={m.to} to={m.to} end={m.to === "/"}>
              <span>{m.label}</span>
            </NavLink>
          ))}
        </nav>
      </header>
      <div className="main-area">
        <main ref={workspaceMotion} id="workspace" data-section={section}>
          <ErrorNotice error={error} />
          <Outlet />
        </main>
        <footer className="app-footer">
          <span>HoneyForge</span>
          <span>Система управления ловушками</span>
        </footer>
      </div>
      <Modal
        open={search}
        onClose={() => setSearch(false)}
        title="Быстрый переход"
        description="Найдите раздел или действие. ↑ ↓ для выбора, Enter для перехода."
      >
        <div
          className="command-palette"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((i) => Math.min(matches.length - 1, i + 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((i) => Math.max(0, i - 1));
            }
            if (e.key === "Enter" && matches[cursor]) {
              e.preventDefault();
              go(matches[cursor].to);
            }
          }}
        >
          <input
            data-initial-focus
            aria-label="Найти раздел или действие"
            placeholder="Раздел или действие…"
            value={term}
            onChange={(e) => {
              setTerm(e.target.value);
              setCursor(0);
            }}
          />
          <div className="command-results" aria-label="Результаты поиска">
            {matches.map((c, i) => (
              <button
                key={c.to}
                className={cursor === i ? "current" : ""}
                onMouseEnter={() => setCursor(i)}
                onClick={() => go(c.to)}
              >
                <c.icon size={16} />
                <span>
                  {c.label}
                  <small>{c.section}</small>
                </span>
                <ArrowUpRight size={14} />
              </button>
            ))}
            {!matches.length && (
              <p className="quiet-empty">Нет подходящих разделов.</p>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}
