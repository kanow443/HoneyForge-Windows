import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode, FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { ArrowRight, LockKeyhole } from "lucide-react";
import { api, ApiError } from "../../shared/api/client";
import type { User } from "../../shared/api/models";
import { ErrorNotice, Field, Loading, Logo } from "../../shared/ui";
type AuthValue = {
  user: User | null;
  loading: boolean;
  setUser: (user: User | null) => void;
  logout: () => Promise<void>;
};
const AuthContext = createContext<AuthValue>(null!);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<unknown>(null);
  const client = useQueryClient();
  const load = () => {
    setLoading(true);
    setError(null);
    api
      .me()
      .then(setUser)
      .catch((e) => {
        if (!(e instanceof ApiError && e.status === 401)) setError(e);
      })
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
    const expired = () => {
      setUser(null);
      client.clear();
    };
    window.addEventListener("auth-expired", expired);
    return () => window.removeEventListener("auth-expired", expired);
  }, []);
  const logout = async () => {
    await api.logout();
    setUser(null);
    client.clear();
  };
  return (
    <AuthContext.Provider value={{ user, loading, setUser, logout }}>
      {error ? (
        <div className="auth-recovery">
          <Logo />
          <ErrorNotice error={error} onRetry={load} />
        </div>
      ) : (
        children
      )}
    </AuthContext.Provider>
  );
}
export function useAuth() {
  return useContext(AuthContext);
}
export function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading />;
  if (!user)
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname + location.search }}
      />
    );
  return children;
}
export function Login() {
  const { user, loading, setUser } = useAuth();
  const [username, setUsername] = useState("operator"),
    [password, setPassword] = useState(""),
    [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(null);
  const nav = useNavigate(),
    location = useLocation();
  if (loading) return <Loading />;
  if (user) return <Navigate to={user.role === "participant" ? "/flags" : "/"} replace />;
  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const signedIn = await api.login({ username, password });
      setUser(signedIn);
      setPassword("");
      nav(location.state?.from ?? (signedIn.role === "participant" ? "/flags" : "/"), { replace: true });
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="login-page">
      <div className="login-brand">
        <Logo />
      </div>
      <div className="login-form-wrap">
        <form onSubmit={submit} className="login-form">
          <h2>Вход в HoneyForge</h2>
          <p className="muted">Используйте учётную запись оператора.</p>
          <ErrorNotice error={error} />
          <Field label="Имя пользователя">
            <input
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              maxLength={80}
            />
          </Field>
          <Field label="Пароль">
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              maxLength={200}
            />
          </Field>
          <button className="button primary wide" disabled={pending}>
            {pending ? "Входим…" : "Войти в панель"}
            <ArrowRight size={17} />
          </button>
          <p className="login-security">
            <LockKeyhole size={13} /> Доступ только для авторизованных
            операторов
          </p>
        </form>
      </div>
    </div>
  );
}
