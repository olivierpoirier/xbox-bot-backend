import { memo, useEffect, useMemo, useRef } from "react";

interface Props {
  bars?: number;
  playing: boolean;
  colorFrom?: string;
  colorTo?: string;
  className?: string;
}

const FRAME_INTERVAL_MS = 1000 / 30;
const REST_HEIGHT = 0.06;

function SpectrumBars({
  bars = 62,
  playing,
  colorFrom = "var(--c1)",
  colorTo = "var(--c2)",
  className = "",
}: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const barRefs = useRef<Array<HTMLDivElement | null>>([]);
  const heightsRef = useRef<Float32Array>(
    new Float32Array(bars).fill(REST_HEIGHT)
  );

  if (heightsRef.current.length !== bars) {
    heightsRef.current = new Float32Array(bars).fill(REST_HEIGHT);
    barRefs.current = [];
  }

  const phases = useMemo(() => {
    const tau = Math.PI * 2;
    const values: Array<[number, number, number, number]> = [];

    for (let i = 0; i < bars; i++) {
      const rnd = mulberry32(0x9e3779b9 ^ i);
      values.push([rnd() * tau, rnd() * tau, rnd() * tau, rnd()]);
    }

    return values;
  }, [bars]);

  const colors = useMemo(
    () =>
      Array.from({ length: bars }, (_, i) => {
        const progress = bars <= 1 ? 0 : i / (bars - 1);
        return `color-mix(in oklab, ${colorFrom} ${Math.round(
          (1 - progress) * 100
        )}%, ${colorTo} ${Math.round(progress * 100)}%)`;
      }),
    [bars, colorFrom, colorTo]
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    let frame: number | null = null;
    let lastFrameAt = 0;
    let inViewport = false;
    let settled = false;

    const stop = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    };

    const renderFrame = (timestamp: number) => {
      frame = null;

      if (document.hidden || !inViewport || settled) return;

      if (timestamp - lastFrameAt < FRAME_INTERVAL_MS) {
        frame = requestAnimationFrame(renderFrame);
        return;
      }

      lastFrameAt = timestamp;
      const prelim = new Float32Array(bars);
      const time = timestamp / 235;

      if (playing) {
        for (let i = 0; i < bars; i++) {
          const [p1, p2, p3, seed] = phases[i];
          const v1 = Math.sin(time * (1.1 + 0.07 * seed) + p1);
          const v2 = Math.sin(time * (0.55 + 0.33 * seed) + p2);
          const v3 = Math.sin(time * (0.78 + 0.12 * seed) + p3);
          const lane = Math.sin(
            time * 0.35 + i * (0.22 + 0.03 * seed)
          );

          let value =
            0.34 + 0.23 * v1 + 0.19 * v2 + 0.15 * v3 + 0.07 * lane;
          value = 0.5 + 0.5 * value;
          value *= 0.86 + 0.18 * (1 - i / Math.max(1, bars - 1));
          prelim[i] = value;
        }
      } else {
        prelim.fill(REST_HEIGHT);
      }

      const average =
        prelim.reduce((sum, value) => sum + value, 0) / Math.max(1, bars);
      const compression = 0.65 * Math.max(0, average - 0.62);
      let allAtRest = !playing;

      for (let i = 0; i < bars; i++) {
        const target = playing
          ? clamp(prelim[i] - compression, REST_HEIGHT, 0.9)
          : REST_HEIGHT;
        const previous = heightsRef.current[i];
        const easing = target > previous ? 0.55 : 0.25;
        const next = previous + (target - previous) * easing;

        heightsRef.current[i] = next;
        barRefs.current[i]?.style.setProperty(
          "transform",
          `translateZ(0) scaleY(${next})`
        );

        if (Math.abs(next - REST_HEIGHT) > 0.003) allAtRest = false;
      }

      settled = allAtRest;
      if (!settled) frame = requestAnimationFrame(renderFrame);
    };

    const start = () => {
      if (frame === null && !document.hidden && inViewport && !settled) {
        frame = requestAnimationFrame(renderFrame);
      }
    };

    const observer = new IntersectionObserver(([entry]) => {
      inViewport = Boolean(entry?.isIntersecting);
      if (inViewport) start();
      else stop();
    });

    const onVisibilityChange = () => {
      if (document.hidden) stop();
      else start();
    };

    observer.observe(root);
    document.addEventListener("visibilitychange", onVisibilityChange);
    start();

    return () => {
      stop();
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [bars, phases, playing]);

  return (
    <div
      ref={rootRef}
      className={`flex items-end gap-[3px] h-full w-full ${className}`}
    >
      {colors.map((background, i) => (
        <div
          key={i}
          ref={(element) => {
            barRefs.current[i] = element;
          }}
          className="flex-1 h-full rounded-sm origin-bottom"
          style={{
            transform: `translateZ(0) scaleY(${heightsRef.current[i]})`,
            background,
            boxShadow: `0 0 3px ${background}`,
          }}
        />
      ))}
    </div>
  );
}

export default memo(SpectrumBars);

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function mulberry32(seed: number) {
  let value = seed >>> 0;
  return function () {
    value += 0x6d2b79f5;
    let result = Math.imul(value ^ (value >>> 15), 1 | value);
    result ^= result + Math.imul(result ^ (result >>> 7), 61 | result);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}
