import { initConsoleLogCapture } from "@/lib/consoleLogBuffer";

// Hook Node console into the shared ring buffer as soon as the server boots,
// so startup, token-refresh, and /v1 proxy traffic before visiting /dashboard/console-log
// are already buffered when the SSE viewer connects.
export async function register() {
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NEXT_PHASE !== "phase-production-build"
  ) {
    initConsoleLogCapture();
  }
}
