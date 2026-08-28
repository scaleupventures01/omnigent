import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
}

/** Keep an unsupported browser API or stale chunk from leaving a blank app. */
export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    void fetch("/__client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: error.name,
        message: error.message,
        stack: error.stack,
        componentStack: info.componentStack,
        pathname: window.location.pathname,
      }),
      keepalive: true,
    }).catch(() => undefined);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-6 text-center text-foreground">
        <section className="max-w-sm space-y-4">
          <h1 className="text-lg font-semibold">Omnigent needs to reconnect</h1>
          <p className="text-sm text-muted-foreground">
            The page could not finish loading. Reload to reconnect without losing this link.
          </p>
          <button
            type="button"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </section>
      </main>
    );
  }
}
