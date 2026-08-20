import { performance } from "node:perf_hooks";

export type Span = {
  name: string;
  t0: number;
  t1?: number;
  data?: Record<string, unknown>;
};

export function startSpan(name: string, data?: Record<string, unknown>) {
  const s: Span = { name, t0: performance.now(), data };
  return {
    end(extra?: Record<string, unknown>) {
      s.t1 = performance.now();
      if (extra) s.data = { ...(s.data || {}), ...extra };
      return s;
    },
    span: s,
  };
}

export type PlayMetrics = {
  id: string;
  spans: Span[];
  startedAt: number;
};

const LAST: PlayMetrics[] = [];

export function pushMetrics(m: PlayMetrics) {
  LAST.push(m);
  while (LAST.length > 100) LAST.shift();
  console.log(`[metrics] push id=${m.id} spans=${m.spans.length}`);
}

export type BackendMetric = {
  id: string;
  name: string;
  ok: boolean;
  durationMs: number;
  at: number;
  data?: Record<string, unknown>;
};

const BACKEND_LAST: BackendMetric[] = [];

function nextMetricId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function recordBackendMetric(
  name: string,
  durationMs: number,
  ok: boolean,
  data?: Record<string, unknown>
): void {
  BACKEND_LAST.push({
    id: nextMetricId(),
    name,
    ok,
    durationMs: Math.round(durationMs),
    at: Date.now(),
    data,
  });

  while (BACKEND_LAST.length > 100) BACKEND_LAST.shift();
}

export function getMetrics(): BackendMetric[] {
  return BACKEND_LAST;
}
