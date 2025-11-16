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

export function getMetrics() {
  return LAST;
}
