import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Last-resort boundary around the app. Without it, any render crash (for
 * example a mobile browser rejecting an optional API) unmounts the whole tree
 * and leaves a blank page with no trace. This reports the error to the forked
 * UI's /__client-error log and offers a manual reload. It never reloads on its
 * own, so a crash on boot cannot become a reload loop.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    try {
      void fetch("/__client-error", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify({
          name: error.name,
          message: error.message,
          stack: error.stack,
          componentStack: info.componentStack,
          pathname: window.location.pathname,
          userAgent: navigator.userAgent,
        }),
      }).catch(() => {});
    } catch {
      // Reporting must never throw from the boundary.
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-foreground">Something went wrong on this page.</p>
        <button
          type="button"
          className="rounded-md border border-border px-4 py-2 text-foreground"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      </div>
    );
  }
}
