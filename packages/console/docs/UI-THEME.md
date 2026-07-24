# Relay Console — UI Theme ("Enterprise Gateway")

The console's design system. **Every new screen follows this.** Corporate, production, calm — a
developer-platform admin console, not a marketing site. Chosen via the ui-ux-pro-max design engine
("Enterprise Gateway" pattern) and a hybrid of the two reference components the team supplied (we took
the **corner-decorator bordered card** from reference #2 as our signature motif and dropped the
skewed-perspective hero from reference #1 — too marketing for an admin tool).

## 1. Foundations

### Typeface

- **Geist** (sans) + **Geist Mono**, self-hosted via the `geist` package in `app/layout.tsx`
  (`--font-geist-sans` / `--font-geist-mono`, wired to Tailwind `font-sans` / `font-mono`). Geist is
  Vercel's typeface — the modern developer-platform standard, more distinctive than Inter.
- **Sans** for all UI. **Mono** for numbers, keys/`last4`, audit seq/hash, and code snippets
  (`font-mono tabular-nums` on stat values). No other families.
- Weights: 400 body, 500 medium (labels/nav), 600 semibold (headings).

### Color — one accent, neutral everything else

Tokens live in `app/globals.css` (`:root` + `.dark`), consumed through Tailwind (`bg-primary`,
`text-muted-foreground`, …). **Never hardcode hex in components** — use the token.

| Token                           | Light                  | Dark                    | Use                                                     |
| ------------------------------- | ---------------------- | ----------------------- | ------------------------------------------------------- |
| `--primary`                     | blue-600 `221 83% 53%` | blue-500 `217 91% 60%`  | the ONLY accent: buttons, links, focus, corner brackets |
| `--primary-foreground`          | white                  | white                   | text on primary                                         |
| `--background` / `--foreground` | white / near-black     | near-black / near-white | page                                                    |
| `--muted-foreground`            | slate-500-ish          | slate-400-ish           | secondary text (labels, captions)                       |
| `--border` / `--input`          | zinc-200-ish           | zinc-800-ish            | hairlines, field borders                                |
| `--destructive`                 | red                    | dark red                | revoke/delete only                                      |
| `success` (badge)               | emerald-600            | emerald-600             | active/ok status                                        |

Rule: **blue is the accent; grey/slate is 95% of the surface.** No second accent hue (except emerald
for "active/success" badges and red for destructive). Corporate = restraint.

### Shape, spacing, motion

- Radius `--radius: 0.5rem` (cards/inputs). The **signature card is square** (`rounded-none`) with
  corner brackets — the one intentional exception.
- Page padding `p-6`; section rhythm `space-y-6`; card padding `p-6`.
- Transitions **150–300ms**, `transition-colors` only (never animate layout/size). Respect
  `prefers-reduced-motion`.

### Dark mode (dual-mode, mandatory)

- **Strategy:** Tailwind `darkMode: ['class']` + `next-themes` (`components/theme-provider.tsx`,
  wrapped once in `app/layout.tsx`). Every color is a token that swaps under `.dark` — components
  never hardcode a mode.
- **Default:** follows the OS (`defaultTheme="system"`); the user's manual choice persists.
- **Toggle:** `components/theme-toggle.tsx` (sun/moon) — in the console top bar and the landing page.
  It renders a stable placeholder until mounted (no hydration flash) and `<html suppressHydrationWarning>`.
- **Rules:** off-black surfaces (`zinc-950`-ish), never pure `#000`/`#fff`; the blue accent stays blue
  in both modes (brighter blue-500 in dark for contrast); hierarchy + WCAG AA hold in both. **Test both
  modes before shipping** (§4).

## 2. Components (`components/ui/*`)

shadcn/ui primitives over Radix: `button`, `card`, `input`, `label`, `table`, `dialog`, `badge`, plus:

- **`FeatureCard`** (`feature-card.tsx`) — the **signature motif**: a square-cornered `Card` with four
  primary corner brackets (`CardDecorator`). Use it to frame an emphasis panel (onboarding form, empty
  state, a hero stat). Do **not** wrap dense data tables in it — plain `<Card>` for those.
- **`Button`** — `default` (blue) for primary actions, `outline` for secondary, `destructive` for
  revoke/delete, `ghost` for toolbar. Always has `cursor-pointer` + focus ring.
- **`Badge`** — `success` (active), `secondary` (revoked/inactive), `outline` (neutral tags).
- **`ThemeToggle` / `ThemeProvider`** — the dark-mode switch + provider (see Dark mode above).
- **Icons:** `lucide-react` only, sized `size-4`/`h-4 w-4`. One family across the app.
- **Stat tiles** (dashboard): `Card` with an accent icon chip (`bg-primary/10 text-primary`) + a
  `tabular-nums` value; subtle `hover:border-primary/40`.

### App shell

`app/(console)/layout.tsx` — left nav (Dashboard / Applications / Providers / Audit, + Organizations
for admins) + top bar (org id, sign out). Every authenticated screen renders inside it and gates
server-side (`app/lib/auth.ts`).

## 3. Patterns

- **Page header:** `<h1 class="text-2xl font-semibold tracking-tight">` + a `text-sm
text-muted-foreground` subtitle.
- **Data screens:** `<Card>` → `CardHeader`/`CardTitle` → `CardContent` with a `<Table>`; empty state
  is a muted sentence, never a blank card.
- **Forms:** `Label` + `Input` (or the shared `select` class), primary `Button` to submit, inline
  `text-destructive` error. Mutations are server actions.
- **Destructive actions** (revoke/delete) always confirm in a `Dialog` first.
- **One-time secrets** (keys) reveal once with a copy button + warning; never re-render the value.

## 4. Do / Don't (from the ui-ux-pro-max checklist)

**Do:** SVG icons (lucide) sized `size-4`; `cursor-pointer` on every clickable; visible focus rings;
4.5:1 text contrast in both modes; label every input; style light **and** dark.

**Don't:** emojis as icons; scale-transform hovers that shift layout; a second accent colour; hardcoded
hex; content behind the fixed nav; `bg-white/10`-style invisible glass.

## 5. Reference

Skill: `ui-ux-pro-max` → pattern "Enterprise Gateway", style tokens above. Regenerate with:

```bash
python3 ~/.claude/skills/ui-ux-pro-max/scripts/search.py \
  "multi-tenant LLM gateway admin console developer platform enterprise" --design-system -p "Relay Console"
```
