import { formatUsd, type DailyPoint } from '../app/lib/usage';

/**
 * Spend-by-day bar chart — pure inline SVG (no chart lib, no client JS). Theme-aware: bars use the
 * primary token, so it flips with light/dark automatically. Each bar carries a native <title> tooltip.
 */
export function SpendChart({ series }: { series: DailyPoint[] }) {
  if (series.length === 0) {
    return <p className="text-sm text-muted-foreground">No usage in this window yet.</p>;
  }

  const width = 640;
  const height = 160;
  const pad = { top: 8, right: 4, bottom: 20, left: 4 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const max = Math.max(...series.map((p) => p.cost), 0.000001);
  const gap = 4;
  const barW = Math.max(2, plotW / series.length - gap);

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Spend by day"
        className="h-40 w-full min-w-[480px]"
      >
        {/* baseline */}
        <line
          x1={pad.left}
          y1={pad.top + plotH}
          x2={width - pad.right}
          y2={pad.top + plotH}
          className="stroke-border"
          strokeWidth={1}
        />
        {series.map((p, i) => {
          const h = (p.cost / max) * plotH;
          const x = pad.left + i * (barW + gap);
          const y = pad.top + plotH - h;
          const showLabel =
            i === 0 || i === series.length - 1 || i === Math.floor(series.length / 2);
          return (
            <g key={p.date}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={Math.max(1, h)}
                rx={2}
                className="fill-primary/80 transition-colors hover:fill-primary"
              >
                <title>{`${p.date}: ${formatUsd(p.cost)} · ${p.requests.toLocaleString()} req`}</title>
              </rect>
              {showLabel ? (
                <text
                  x={x + barW / 2}
                  y={height - 6}
                  textAnchor="middle"
                  className="fill-muted-foreground font-mono text-[9px]"
                >
                  {p.date.slice(5)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
