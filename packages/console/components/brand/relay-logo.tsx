/**
 * The Relay brand mark.
 *
 * The glyph is the product: ONE inbound node — the single OpenAI-compatible endpoint a client talks
 * to — fanning out through a junction into three routed outbounds, which is literally what the
 * gateway does with a request. A logo that draws the architecture beats an abstract swoosh, because
 * a developer reads it once and understands what they are looking at.
 *
 * Built as strokes on `currentColor`, so it inherits the surrounding text colour and works on the
 * nav, in the footer, on a blue tile, and in both themes without a second asset. Drawn on a 24-unit
 * grid with 1.75 stroke and generous node radii so it still resolves at 16px in a browser tab —
 * favicon legibility is the constraint that kills most marks, so it was designed for first.
 */
export function RelayMark({ className = 'size-6' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {/* inbound: the client's single endpoint */}
      <circle cx="3.75" cy="12" r="1.75" fill="currentColor" stroke="none" />
      {/* the stem into the routing junction */}
      <path d="M5.5 12h4" />
      {/* three routes out of the junction — priority, weighted, failover */}
      <path d="M9.5 12c4 0 4-6 8.25-6" />
      <path d="M9.5 12h8.25" />
      <path d="M9.5 12c4 0 4 6 8.25 6" />
      {/* outbound providers */}
      <circle cx="19.75" cy="6" r="1.6" />
      <circle cx="19.75" cy="12" r="1.6" />
      <circle cx="19.75" cy="18" r="1.6" />
    </svg>
  );
}

/**
 * Mark + wordmark lockup. The mark sits in a primary tile so the accent appears exactly once in the
 * nav, which is what keeps a single-accent system from turning into a rainbow as sections are added.
 */
export function RelayLogo({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <RelayMark className="size-5" />
      </span>
      <span className="text-lg font-semibold tracking-tight">Relay</span>
    </span>
  );
}
