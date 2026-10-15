import "@vly-ai/integrations";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "next-themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VlyToolbar } from "../vly-toolbar-readonly.tsx";
import React, { StrictMode, Suspense, lazy, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Outlet, Route, Routes, useLocation } from "react-router";
import { AppLayout } from "@/components/layout/AppLayout";
import "./index.css";

// Route-level code splitting keeps the first paint small.
const Landing = lazy(() => import("./pages/Landing.tsx"));
const Dashboard = lazy(() => import("./pages/Dashboard.tsx"));
const CompanySearch = lazy(() => import("./pages/CompanySearch.tsx"));
const CompanyDetails = lazy(() => import("./pages/CompanyDetails.tsx"));
const Contacts = lazy(() => import("./pages/Contacts.tsx"));
const SavedLeads = lazy(() => import("./pages/SavedLeads.tsx"));
const SavedSearches = lazy(() => import("./pages/SavedSearches.tsx"));
const Exports = lazy(() => import("./pages/Exports.tsx"));
const DatasetManagement = lazy(() => import("./pages/DatasetManagement.tsx"));
const Settings = lazy(() => import("./pages/Settings.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 10 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function RouteLoading() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="size-1.5 animate-pulse rounded-full bg-primary" />
        Loading…
      </div>
    </div>
  );
}

/** Silent error boundary so a toolbar failure cannot blank the app. */
class ToolbarErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(err: Error) {
    console.warn("[VlyToolbar] disabled:", err.message);
  }
  render() {
    return this.state.hasError ? null : this.props.children;
  }
}

/** Root error boundary: a runtime error shows a readable message, never a blank page. */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string; stack: string }
> {
  state = { hasError: false, message: "", stack: "" };
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error.message || "Unknown runtime error", stack: error.stack || "" };
  }
  componentDidCatch(err: Error) {
    console.error("[CompanyIntel] render failure:", err);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
          <div className="max-w-lg text-center">
            <p className="text-sm font-semibold">Something went wrong rendering this screen</p>
            <p className="mt-2 text-xs text-muted-foreground break-words">{this.state.message}</p>
            {this.state.stack ? (
              <pre className="mt-3 max-h-40 overflow-auto rounded border border-border/60 p-2 text-left text-[10px] leading-4 text-muted-foreground/80">
                {this.state.stack}
              </pre>
            ) : null}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Keeps the host toolbar in sync with client-side navigation. */
function RouteSyncer() {
  const location = useLocation();
  useEffect(() => {
    window.parent.postMessage({ type: "iframe-route-change", path: location.pathname }, "*");
  }, [location.pathname]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type === "navigate") {
        if (event.data.direction === "back") window.history.back();
        if (event.data.direction === "forward") window.history.forward();
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <ToolbarErrorBoundary>
        <VlyToolbar />
      </ToolbarErrorBoundary>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem enableColorScheme disableTransitionOnChange>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <RouteSyncer />
            <Suspense fallback={<RouteLoading />}>
              <Routes>
                <Route path="/" element={<Landing />} />
                <Route element={<AppLayout />}>
                  <Route path="/dashboard" element={<Dashboard />} />
                  <Route path="/companies" element={<CompanySearch />} />
                  <Route path="/companies/:companyId" element={<CompanyDetails />} />
                  <Route path="/contacts" element={<Contacts />} />
                  <Route path="/leads" element={<SavedLeads />} />
                  <Route path="/saved-searches" element={<SavedSearches />} />
                  <Route path="/exports" element={<Exports />} />
                  <Route path="/dataset" element={<DatasetManagement />} />
                  <Route path="/settings" element={<Settings />} />
                </Route>
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </BrowserRouter>
          <Toaster />
        </QueryClientProvider>
      </ThemeProvider>
    </RootErrorBoundary>
  </StrictMode>,
);

/** Kept for tooling that inspects the module tree. */
export const appRoutes = ["/dashboard", "/companies", "/contacts", "/leads", "/saved-searches", "/exports", "/dataset", "/settings"];
export { Outlet };
