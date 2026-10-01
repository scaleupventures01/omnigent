import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.tsx";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { PWAUpdateBanner } from "./components/pwa/PWAUpdateBanner";
import { ThemeProvider } from "./components/theme/ThemeProvider";
import { TooltipProvider } from "./components/ui/tooltip";
import { ImageLightboxProvider } from "./components/ImageLightbox";
import { RunnerHealthProvider } from "./hooks/RunnerHealthProvider";
import { QueueFlushProvider } from "./hooks/QueueFlushProvider";
import { SessionUpdatesProvider } from "./hooks/SessionUpdatesProvider";
import { resolveServerInfo, type ServerInfo } from "./lib/capabilities";
import { CapabilitiesProvider } from "./lib/CapabilitiesContext";
import { resolveIdentity } from "./lib/identity";
import { initNativeInsets } from "./lib/nativeInsets";
import { initBrowserTelemetry } from "./lib/telemetry";
import {
  applyDesktopUiFontSize,
  applyUiFontFamily,
  readUiFontFamily,
  readUiFontSizePx,
} from "./lib/uiFontPreferences";
import { applyThemePalette, readThemePalette } from "./lib/themePalette";
import { applyCustomTheme, readCustomTheme } from "./lib/customTheme";
import { initChatStore } from "./store/chatStore";
import "katex/dist/katex.min.css";
import "streamdown/styles.css";
import "./index.css";

// Start tracing before any request fires so fetch/XHR are patched in time
// and a trace begins in the browser. No-op unless a collector endpoint is
// configured (VITE_OTEL_EXPORTER_OTLP_ENDPOINT).
initBrowserTelemetry();

// A tab still running an older build can ask for a lazy chunk a later deploy
// removed. Vite dispatches `vite:preloadError` for that; reload once into the
// current build instead of leaving the page broken. The timestamp guard stops
// a reload loop if the chunk is missing from the current build too.
if (typeof window !== "undefined") {
  window.addEventListener("vite:preloadError", (event) => {
    const key = "omnigent:chunk-reload-at";
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(key)) || 0;
    } catch {
      // sessionStorage access errors are non-fatal.
    }
    if (Date.now() - last < 30_000) return;
    try {
      sessionStorage.setItem(key, String(Date.now()));
    } catch {
      // sessionStorage access errors are non-fatal.
    }
    event.preventDefault();
    try {
      sessionStorage.setItem("omnigent:reload-cause", "chunk-preload-error");
    } catch {
      // sessionStorage access errors are non-fatal.
    }
    window.location.reload();
  });
}

// Diagnostic: on every boot that follows a reload (or a browser tab discard),
// report why to the forked UI's /__client-error log. Distinguishes our own
// reloads (reload-cause set just before them) from the browser killing and
// restoring the tab, which leaves no cause behind.
if (typeof window !== "undefined") {
  try {
    const nav = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    const doc = document as Document & { wasDiscarded?: boolean };
    const cause = sessionStorage.getItem("omnigent:reload-cause");
    sessionStorage.removeItem("omnigent:reload-cause");
    const prevUnload = sessionStorage.getItem("omnigent:unload");
    sessionStorage.removeItem("omnigent:unload");
    const lastBoot = Number(sessionStorage.getItem("omnigent:last-boot-at")) || 0;
    const now = Date.now();
    sessionStorage.setItem("omnigent:last-boot-at", String(now));
    if (nav?.type === "reload" || doc.wasDiscarded || cause) {
      void fetch("/__client-error", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify({
          name: "boot-diagnostic",
          navType: nav?.type ?? null,
          wasDiscarded: doc.wasDiscarded ?? null,
          ourCause: cause,
          secondsSinceLastBoot: lastBoot ? Math.round((now - lastBoot) / 1000) : null,
          // Set by the pagehide listener below. Missing on a reload means the
          // old page never got pagehide: the renderer was killed, not unloaded.
          cleanUnload: prevUnload ? JSON.parse(prevUnload) : null,
          build: document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')?.src.split("/").pop() ?? null,
          pathname: window.location.pathname,
          userAgent: navigator.userAgent,
        }),
      }).catch(() => {});
    }
  } catch {
    // Diagnostics must never break boot.
  }
  let hiddenAt: number | null = null;
  document.addEventListener("visibilitychange", () => {
    hiddenAt = document.visibilityState === "hidden" ? Date.now() : null;
  });
  window.addEventListener("pagehide", () => {
    try {
      sessionStorage.setItem(
        "omnigent:unload",
        JSON.stringify({
          at: Date.now(),
          visibility: document.visibilityState,
          hiddenForSeconds: hiddenAt ? Math.round((Date.now() - hiddenAt) / 1000) : null,
        }),
      );
    } catch {
      // sessionStorage access errors are non-fatal.
    }
  });
}

// Single client at module scope — shared across the whole app.
//
// `refetchOnWindowFocus: false` is intentional: window-focus auto-refetch
// is great for SaaS dashboards but noisy for chat. We can re-enable
// per-query later (e.g. the agents list, when we add it) by passing
// `refetchOnWindowFocus: true` on that specific `useQuery`.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false },
  },
});

// Hand the QueryClient to the chat store so its actions can
// invalidate cached queries (e.g. the conversations list when a new
// conversation is created server-side).
initChatStore(queryClient);

// Discover the current user identity from the server. Once resolved,
// all subsequent fetch calls include X-Forwarded-Email so session
// routes know who's making the request.
void resolveIdentity();

// Mirror the iOS shell's native bar footprints into the inset CSS variables.
// No-op off the iOS shell (the inset vars stay at their env()-only defaults).
initNativeInsets();

// Apply the saved desktop UI font size and family before first paint so there's no flash.
applyDesktopUiFontSize(readUiFontSizePx());
applyUiFontFamily(readUiFontFamily());

// The standalone sidebar font size control was removed. Clear its legacy value
// so sidebar items follow the shared desktop interface size.
if (typeof window !== "undefined") {
  try {
    localStorage.removeItem("omnigent:sidebar-font-size");
  } catch {
    // localStorage access errors are non-fatal.
  }
}

// Apply the saved color palette (data-theme on <html>) before first paint too,
// so the app renders in the chosen theme rather than flashing the brand default.
applyCustomTheme(readCustomTheme());
applyThemePalette(readThemePalette());

// Probe /v1/info BEFORE the first render so the route table knows
// whether to mount accounts routes. The probe is unauthed and the
// failure path resolves to "accounts off" — so even a stalled or
// missing server doesn't deadlock first paint. We add a small
// safety timeout (1.5s) so users on a flaky network still get
// something on screen.
const bootProbe: Promise<ServerInfo> = Promise.race([
  resolveServerInfo(),
  new Promise<ServerInfo>((resolve) => {
    setTimeout(
      () =>
        resolve({
          accounts_enabled: false,
          single_user: false,
          login_url: null,
          needs_setup: false,
          databricks_features: false,
          managed_sandboxes_enabled: false,
          sandbox_provider: null,
          sharing_mode: "on",
          public_sharing_enabled: true,
          server_version: null,
          smart_routing_enabled: false,
          smart_routing_sources: { external: false, oss: false },
          harness_install_enabled: false,
          installable_harnesses: [],
          dictation_available: false,
        }),
      1500,
    );
  }),
]);

void bootProbe.then((info) => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <CapabilitiesProvider info={info}>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <PWAUpdateBanner />
            <TooltipProvider>
              <ImageLightboxProvider>
                <BrowserRouter>
                  <SessionUpdatesProvider>
                    <RunnerHealthProvider>
                      <QueueFlushProvider>
                        <AppErrorBoundary>
                          <App />
                        </AppErrorBoundary>
                      </QueueFlushProvider>
                    </RunnerHealthProvider>
                  </SessionUpdatesProvider>
                </BrowserRouter>
              </ImageLightboxProvider>
            </TooltipProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </CapabilitiesProvider>
    </StrictMode>,
  );
});
