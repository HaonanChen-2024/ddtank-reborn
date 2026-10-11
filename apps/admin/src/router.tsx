import { createRootRouteWithContext, createRoute, createRouter, notFound, Outlet, redirect, useParams } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { EmptyState } from "@ddtank/ui";
import { meQuery } from "@/lib/api";
import { AdminLayout } from "@/layout/AdminLayout";
import { LoginPage } from "@/pages/Login";
import { DashboardPage } from "@/pages/Dashboard";
import { ServerConfigPage } from "@/pages/ServerConfig";
import { EventsPage } from "@/pages/Events";
import { AssetsPage } from "@/pages/Assets";
import { MailPage } from "@/pages/Mail";
import { ResourcePage } from "@/crud/ResourcePage";
import { resourceByName } from "@/resources";
import { useI18n } from "@/i18n";

interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: function NotFoundPage() {
    const { t } = useI18n();
    return <EmptyState title={t("notFound.title")} className="m-8">404</EmptyState>;
  },
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: (s: Record<string, unknown>): { redirect?: string; denied?: boolean } => ({
    ...(typeof s.redirect === "string" ? { redirect: s.redirect } : {}),
    ...(s.denied ? { denied: true } : {}),
  }),
  component: LoginPage,
});

/** Auth guard: only users with role 'admin' get past this layout. */
const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "authed",
  beforeLoad: async ({ context, location }) => {
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me) throw redirect({ to: "/login", search: { redirect: location.href } });
    if (me.role !== "admin") throw redirect({ to: "/login", search: { denied: true } });
    return { me };
  },
  component: AdminLayout,
});

const dashboardRoute = createRoute({ getParentRoute: () => authedRoute, path: "/", component: DashboardPage });
const configRoute = createRoute({ getParentRoute: () => authedRoute, path: "/config", component: ServerConfigPage });
const eventsRoute = createRoute({ getParentRoute: () => authedRoute, path: "/events", component: EventsPage });
const assetsRoute = createRoute({ getParentRoute: () => authedRoute, path: "/assets", component: AssetsPage });
const mailRoute = createRoute({ getParentRoute: () => authedRoute, path: "/mail", component: MailPage });

function GenericResource() {
  const { resource } = useParams({ from: "/authed/$resource" });
  const def = resourceByName.get(resource)!;
  return <ResourcePage def={def} />;
}

/** Any registered resource: /items, /bots, /texts ... (static routes above win). */
const resourceRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: "$resource",
  beforeLoad: ({ params }) => {
    if (!resourceByName.has(params.resource)) throw notFound();
  },
  component: GenericResource,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  authedRoute.addChildren([dashboardRoute, configRoute, eventsRoute, assetsRoute, mailRoute, resourceRoute]),
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({ routeTree, context: { queryClient }, defaultPreload: "intent" });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
