'use client';

/**
 * The two places the landing page uses the particle field.
 *
 * Both load `SparklesCore` through `next/dynamic` with `ssr: false`: the tsparticles engine is
 * ~90KB and paints to a canvas, so there is nothing for the server to render and no reason for it
 * to sit in the initial bundle of the page whose first paint matters most. It arrives after the
 * page is interactive and fades itself in.
 *
 * A sized placeholder holds the exact height in the meantime, so the late arrival never pushes
 * layout around — a particle field that shifts the page as it loads would trade a nice effect for a
 * Cumulative Layout Shift penalty.
 */
import dynamic from 'next/dynamic';

const SparklesCore = dynamic(() => import('../ui/sparkles').then((mod) => mod.SparklesCore), {
  ssr: false,
  loading: () => <div className="h-full w-full" />,
});

/**
 * The thin band under the hero: two gradient rails with the field falling away beneath them, masked
 * at the edges so it does not end on a hard line. The rails are the reference's motif, recoloured
 * from indigo/sky to our single accent.
 */
export function SparklesBand() {
  return (
    <div
      className="pointer-events-none relative mx-auto mt-12 h-24 w-full max-w-2xl"
      aria-hidden="true"
    >
      <div className="absolute inset-x-16 top-0 h-px bg-gradient-to-r from-transparent via-primary to-transparent" />
      <div className="absolute inset-x-16 top-0 h-[2px] bg-gradient-to-r from-transparent via-primary to-transparent blur-sm" />
      <div className="absolute inset-x-1/3 top-0 h-px bg-gradient-to-r from-transparent via-primary/70 to-transparent" />
      <div className="absolute inset-x-1/3 top-0 h-[4px] bg-gradient-to-r from-transparent via-primary/70 to-transparent blur-md" />

      <SparklesCore
        id="relay-hero-sparkles"
        background="transparent"
        minSize={0.4}
        maxSize={1.1}
        particleDensity={900}
        speed={4}
        className="h-full w-full"
      />

      {/* Feathers the field into the page. `bg-background` keeps it correct in both themes — the
          reference hardcodes bg-black, which would paint a black slab across our light mode. */}
      <div className="absolute inset-0 bg-background [mask-image:radial-gradient(430px_140px_at_top,transparent_50%,black)]" />
    </div>
  );
}

/**
 * The closing wordmark: "Relay" at display size over a full-bleed field, the page's last beat.
 *
 * This is the reference's `SparklesPreview` composition with Acme replaced by our name — but the
 * word is real page text (`<h2>`), not an image, so it is selectable, translatable and announced
 * once by a screen reader while the canvas beneath stays `aria-hidden`.
 */
export function SparklesWordmark() {
  return (
    <div className="relative flex h-[22rem] w-full flex-col items-center justify-center overflow-hidden md:h-[26rem]">
      <div className="absolute inset-0" aria-hidden="true">
        <SparklesCore
          id="relay-wordmark-sparkles"
          background="transparent"
          minSize={0.6}
          maxSize={1.4}
          particleDensity={110}
          speed={1.2}
          className="h-full w-full"
        />
      </div>

      <div className="relative z-20 flex flex-col items-center px-6">
        <h2 className="bg-gradient-to-b from-foreground to-foreground/45 bg-clip-text text-center text-6xl font-semibold tracking-tight text-transparent md:text-8xl lg:text-9xl">
          Relay
        </h2>
        <p className="mt-4 max-w-md text-center text-sm text-muted-foreground">
          One endpoint. Every model. Running on your own infrastructure.
        </p>
      </div>

      {/* Rails sit under the word, mirroring the hero band so the page closes on the motif it opened with. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-24 h-px" aria-hidden="true">
        <div className="absolute inset-x-[20%] h-px bg-gradient-to-r from-transparent via-primary to-transparent" />
        <div className="absolute inset-x-[20%] h-[3px] bg-gradient-to-r from-transparent via-primary to-transparent blur-sm" />
        <div className="absolute inset-x-[38%] h-px bg-gradient-to-r from-transparent via-primary/70 to-transparent" />
      </div>

      {/* Vignette: fades the field out at every edge so the section blends into the footer. */}
      <div
        className="pointer-events-none absolute inset-0 bg-background [mask-image:radial-gradient(ellipse_at_center,transparent_25%,black_78%)]"
        aria-hidden="true"
      />
    </div>
  );
}
