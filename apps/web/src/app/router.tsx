import { lazy, Suspense } from "react";
import { createBrowserRouter, Link, RouterProvider } from "react-router-dom";
import { Protected, Login } from "../features/auth/Auth";
import { RequirePermission } from "../features/auth/permissions";
import { OverviewPage } from "../features/overview/Overview";
import { HostsPage } from "../features/hosts/Hosts";
const GroupDeploymentForm = lazy(() =>
  import("../features/deployments/Groups").then((m) => ({
    default: m.GroupDeploymentForm,
  })),
);
const GroupDetailPage = lazy(() =>
  import("../features/deployments/Groups").then((m) => ({
    default: m.GroupDetailPage,
  })),
);
const ProfilesPage = lazy(() =>
  import("../features/profiles/Profiles").then((m) => ({
    default: m.ProfilesPage,
  })),
);
const ProfileDetail = lazy(() =>
  import("../features/profiles/Profiles").then((m) => ({
    default: m.ProfileDetail,
  })),
);
const BuilderPage = lazy(() =>
  import("../features/profiles/Builder").then((m) => ({
    default: m.BuilderPage,
  })),
);
const UsersPage = lazy(() =>
  import("../features/users/Users").then((m) => ({ default: m.UsersPage })),
);
const IntegrationsPage = lazy(() =>
  import("../features/integrations/Integrations").then((m) => ({
    default: m.IntegrationsPage,
  })),
);
const StoragePage = lazy(() =>
  import("../features/evidence/Storage").then((m) => ({
    default: m.StoragePage,
  })),
);
import {
  DeploymentForm,
  TrapDetail,
  TrapsPage,
} from "../features/deployments/Deployments";
const EventsPage = lazy(() =>
  import("../features/events/Events").then((m) => ({ default: m.EventsPage })),
);
const FlagsPage = lazy(() =>
  import("../features/flags/Flags").then((m) => ({ default: m.FlagsPage })),
);
const CasesPage = lazy(() =>
  import("../features/sessions/Cases").then((m) => ({ default: m.CasesPage })),
);
const ReportPage = lazy(() =>
  import("../features/sessions/Report").then((m) => ({
    default: m.ReportPage,
  })),
);
const SessionPage = lazy(() =>
  import("../features/sessions/Sessions").then((m) => ({
    default: m.SessionPage,
  })),
);
const AuditPage = lazy(() =>
  import("../features/audit/Audit").then((m) => ({ default: m.AuditPage })),
);
import { Layout } from "./Layout";
import { LiveProvider } from "./LiveProvider";
import { Empty, Loading } from "../shared/ui";
const router = createBrowserRouter([
  { path: "/login", element: <Login /> },
  {
    element: (
      <Protected>
        <LiveProvider>
          <Layout />
        </LiveProvider>
      </Protected>
    ),
    children: [
      { path: "/", element: <OverviewPage /> },
      { path: "/flags", element: <Suspense fallback={<Loading />}><FlagsPage /></Suspense> },
      { path: "/hosts", element: <HostsPage /> },
      {
        path: "/profiles",
        element: (
          <Suspense fallback={<Loading />}>
            <ProfilesPage />
          </Suspense>
        ),
      },
      {
        path: "/profiles/new",
        element: (
          <Suspense fallback={<Loading />}>
            <RequirePermission permission="operate">
              <BuilderPage />
            </RequirePermission>
          </Suspense>
        ),
      },
      {
        path: "/profiles/:id",
        element: (
          <Suspense fallback={<Loading />}>
            <ProfileDetail />
          </Suspense>
        ),
      },
      {
        path: "/profiles/:id/edit",
        element: (
          <Suspense fallback={<Loading />}>
            <RequirePermission permission="operate">
              <BuilderPage />
            </RequirePermission>
          </Suspense>
        ),
      },
      { path: "/traps", element: <TrapsPage /> },
      {
        path: "/groups/new",
        element: (
          <RequirePermission permission="operate">
            <Suspense fallback={<Loading />}>
              <GroupDeploymentForm />
            </Suspense>
          </RequirePermission>
        ),
      },
      {
        path: "/groups/:id",
        element: (
          <Suspense fallback={<Loading />}>
            <GroupDetailPage />
          </Suspense>
        ),
      },
      {
        path: "/traps/new",
        element: (
          <RequirePermission permission="operate">
            <DeploymentForm />
          </RequirePermission>
        ),
      },
      {
        path: "/users",
        element: (
          <RequirePermission permission="admin">
            <Suspense fallback={<Loading />}>
              <UsersPage />
            </Suspense>
          </RequirePermission>
        ),
      },
      { path: "/traps/:id", element: <TrapDetail /> },
      {
        path: "/integrations",
        element: (
          <RequirePermission permission="admin">
            <Suspense fallback={<Loading />}>
              <IntegrationsPage />
            </Suspense>
          </RequirePermission>
        ),
      },
      {
        path: "/events",
        element: (
          <Suspense fallback={<Loading />}>
            <EventsPage />
          </Suspense>
        ),
      },
      {
        path: "/storage",
        element: (
          <Suspense fallback={<Loading />}>
            <StoragePage />
          </Suspense>
        ),
      },
      {
        path: "/sessions/:id",
        element: (
          <Suspense fallback={<Loading />}>
            <SessionPage />
          </Suspense>
        ),
      },
      {
        path: "/sessions/:id/report",
        element: (
          <Suspense fallback={<Loading />}>
            <ReportPage />
          </Suspense>
        ),
      },
      {
        path: "/cases",
        element: (
          <Suspense fallback={<Loading />}>
            <CasesPage />
          </Suspense>
        ),
      },
      {
        path: "/audit",
        element: (
          <Suspense fallback={<Loading />}>
            <AuditPage />
          </Suspense>
        ),
      },
      {
        path: "*",
        element: (
          <Empty
            title="Страница не найдена"
            description="Проверьте адрес или вернитесь в рабочее пространство."
            action={
              <Link className="button" to="/">
                Открыть обзор
              </Link>
            }
          />
        ),
      },
    ],
  },
]);
export function AppRouter() {
  return <RouterProvider router={router} />;
}
