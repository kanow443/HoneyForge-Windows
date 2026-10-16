import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "./features/auth/Auth";
import { AppRouter } from "./app/router";
import { ApiError } from "./shared/api/client";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/cyrillic-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/cyrillic-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/cyrillic-600.css";
import "./app/styles.css";
const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10000,
      retry: (count, error) =>
        !(
          error instanceof ApiError &&
          [401, 403, 404, 422].includes(error.status)
        ) && count < 1,
      refetchOnWindowFocus: true,
    },
    mutations: { retry: false },
  },
});
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <AuthProvider>
        <AppRouter />
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);

import "./app/live-workspace.css";
import "./app/motion.css";
