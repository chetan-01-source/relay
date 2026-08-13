/**
 * A console screenshot in the docs.
 *
 * Three decisions worth the words:
 *
 * 1. **A plain `<img>`, not `next/image`.** The console builds with `output: 'standalone'` and does
 *    not ship `sharp`, so next/image's default loader would need an optimizer at runtime for images
 *    whose dimensions we already know and never change. A static `<img>` with explicit `width` and
 *    `height` gives the same layout guarantee — the browser reserves the box from the aspect ratio
 *    before a byte arrives — at no runtime cost.
 *
 * 2. **`loading="lazy"` everywhere.** These are ~250–480 KB each. A docs page carrying three of them
 *    would otherwise spend its entire load budget on pictures of itself.
 *
 * 3. **`alt` says what the screen SHOWS, not that it is a screenshot.** A screen reader already
 *    announces "image"; repeating it wastes the one sentence that could have conveyed the content.
 *    The caption below is visible to everyone and carries the point being made, so `alt` describes
 *    the interface and the caption argues about it.
 *
 * The captures are dark-mode. That is deliberate rather than an oversight: shipping both themes
 * would double the asset weight to make a screenshot match the reader's own chrome, which nobody
 * has ever asked docs to do. The frame carries a border and a neutral backdrop so the image reads
 * as a framed artifact in light mode instead of a hole punched in the page.
 */
export interface ScreenshotProps {
  /** Path under `public/`, e.g. `/docs/console-routes.png`. */
  src: string;
  /** What the interface shows. Not "a screenshot of…" — see the note above. */
  alt: string;
  /** The point this image is making. Rendered under the frame, visible to everyone. */
  caption: string;
  /** Intrinsic pixel size, so the box is reserved before the image loads. */
  width?: number;
  height?: number;
  /** Set on the one image above the fold, if any — lazy-loading the LCP element delays it. */
  priority?: boolean;
}

export function Screenshot({
  src,
  alt,
  caption,
  width = 1760,
  height = 1144,
  priority = false,
}: ScreenshotProps) {
  return (
    <figure className="my-6">
      <div className="overflow-hidden rounded-lg border bg-muted/40 p-1.5">
        <img
          src={src}
          alt={alt}
          width={width}
          height={height}
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
          // `h-auto` with the width/height attributes present: the attributes reserve the aspect
          // ratio, the classes let it shrink on a phone without distorting.
          className="h-auto w-full rounded-md"
        />
      </div>
      <figcaption className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
        {caption}
      </figcaption>
    </figure>
  );
}
