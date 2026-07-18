import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "@/App";
import { ThemeProvider } from "@/lib/theme";
import { ActiveConnectionProvider } from "@/lib/activeConnection";
import "@/index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // IpcError carries `retriable`; the bindings layer will drive retry policy
      // off it in a later phase. For now, no blind retries.
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("root element not found");
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ActiveConnectionProvider>
          <App />
        </ActiveConnectionProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
