/**
 * Sign-in experience branding — the Logto-hosted pages a user actually sees before they reach the
 * console. Applied idempotently by `seed-auth`, so a rebuilt stack comes back branded rather than
 * showing Logto's purple defaults.
 *
 * Kept next to logto.ts (the Management API client) rather than in a module: this is deployment
 * bootstrap, not a request-path concern, and nothing in the gateway reads it at runtime.
 *
 * Two constraints learned from the live API and encoded here:
 *   • An email sign-up identifier REQUIRES `verify: true`, which requires a working email connector.
 *     Enabling email without one makes registration impossible, so the connector is ensured first.
 *   • `hideLogtoBranding` is rejected on OSS ("not supported in this environment"), so it is not set.
 */

export interface BrandingConfig {
  endpoint: string;
  m2mAppId: string;
  m2mAppSecret: string;
  /** SMTP host Logto sends verification codes through. Absent ⇒ email sign-up is left alone. */
  smtpHost?: string | undefined;
  smtpPort?: number | undefined;
  smtpFrom?: string | undefined;
  smtpUser?: string | undefined;
  smtpPassword?: string | undefined;
}

export interface BrandingResult {
  applied: string[];
  skipped: string[];
}

// Mirrors packages/console/docs/UI-THEME.md §1: one blue accent, brighter in dark for contrast.
const PRIMARY_LIGHT = '#2563EB'; // blue-600
const PRIMARY_DARK = '#3B82F6'; // blue-500

/** The console's app-shell mark: a blue rounded square with a white R. Inlined so there is no asset
 * host to depend on and no broken image if one goes away. */
function logoDataUri(fill: string): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48' viewBox='0 0 48 48'>` +
    `<rect width='48' height='48' rx='10' fill='${fill}'/>` +
    `<text x='24' y='33' font-family='Geist,system-ui,sans-serif' font-size='27' font-weight='700' ` +
    `fill='#fff' text-anchor='middle'>R</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/**
 * Additive on purpose — fonts, radius and colour only. Logto's markup is internal and its class
 * names are hashed, so anything structural would break on upgrade. This survives one.
 */
const CUSTOM_CSS = `/* Relay — Enterprise Gateway theme for Logto's hosted pages.
   Mapped 1:1 onto the console's tokens (packages/console/app/globals.css) so sign-in and the
   dashboard are visibly the same product.

   This overrides Logto's OWN CSS custom properties — the variables its components actually read —
   rather than guessing at class names. Logto ships hashed CSS-module classes that change on every
   release, so selector-based theming breaks on upgrade; variables are the supported surface and
   survive one. Logto sets data-theme on <html> and selects with \`html[data-theme=...]\`, so the
   same selector is used here: equal specificity, and Logto injects this block AFTER its own
   stylesheet, so these win on cascade order. */
@import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap');

html[data-theme='light'], :root[data-theme='light'] {
  --color-brand-default: #2563eb;   /* blue-600 — the one accent */
  --color-brand-hover:   #1d4ed8;
  --color-brand-pressed: #1e40af;
  --color-brand-loading: #60a5fa;

  --color-bg-body:       #ffffff;   /* --background */
  --color-bg-body-base:  #ffffff;
  --color-bg-float:      #ffffff;   /* --card: sign-in panel sits on the page, not above it */
  --color-bg-float-base: #ffffff;
  --color-bg-layer-1:    #ffffff;
  --color-bg-layer-2:    #f4f4f5;   /* --muted */
  --color-bg-light:      #f4f4f5;
  --color-bg-state-unselected: #f4f4f5;
  --color-bg-state-disabled:   #e4e4e7;

  --color-type-primary:   #09090b;  /* --foreground */
  --color-type-secondary: #71717a;  /* --muted-foreground */
  --color-type-disable:   #a1a1aa;
  --color-type-link:      #2563eb;

  --color-line-border:   #e4e4e7;   /* --border (zinc-200) */
  --color-line-divider:  #e4e4e7;

  --color-danger-default: #dc2626;  /* --destructive */
  --color-danger-hover:   #b91c1c;
  --color-danger-pressed: #991b1b;
}

html[data-theme='dark'], :root[data-theme='dark'] {
  --color-brand-default: #3b82f6;   /* blue-500 — brighter on dark, per UI-THEME §1 */
  --color-brand-hover:   #60a5fa;
  --color-brand-pressed: #2563eb;
  --color-brand-loading: #1d4ed8;

  --color-bg-body:       #09090b;   /* off-black, never pure #000 */
  --color-bg-body-base:  #09090b;
  --color-bg-float:      #09090b;
  --color-bg-float-base: #09090b;
  --color-bg-layer-1:    #09090b;
  --color-bg-layer-2:    #27272a;
  --color-bg-light:      #18181b;
  --color-bg-state-unselected: #27272a;
  --color-bg-state-disabled:   #27272a;

  --color-type-primary:   #fafafa;
  --color-type-secondary: #a1a1aa;
  --color-type-disable:   #52525b;
  --color-type-link:      #3b82f6;

  --color-line-border:   #27272a;   /* zinc-800 */
  --color-line-divider:  #27272a;

  --color-danger-default: #ef4444;
  --color-danger-hover:   #dc2626;
  --color-danger-pressed: #b91c1c;
}

/* Geist everywhere. Logto's --font-* are full shorthands (weight size/line-height family), so each
   is restated rather than patching font-family alone — a partial override would be ignored. */
:root {
  --radius: 8px;  /* already matches the console's 0.5rem; restated so it cannot drift */
  --font-headline-1: 600 28px/32px 'Geist', ui-sans-serif, system-ui, sans-serif;
  --font-headline-2: 600 24px/32px 'Geist', ui-sans-serif, system-ui, sans-serif;
  --font-title-1:    600 20px/28px 'Geist', ui-sans-serif, system-ui, sans-serif;
  --font-title-2:    600 18px/24px 'Geist', ui-sans-serif, system-ui, sans-serif;
  --font-title-3:    600 16px/24px 'Geist', ui-sans-serif, system-ui, sans-serif;
  --font-body-1:     400 16px/24px 'Geist', ui-sans-serif, system-ui, sans-serif;
  --font-body-2:     400 14px/20px 'Geist', ui-sans-serif, system-ui, sans-serif;
  --font-body-3:     400 12px/16px 'Geist', ui-sans-serif, system-ui, sans-serif;
  --font-label-1:    500 16px/24px 'Geist', ui-sans-serif, system-ui, sans-serif;
  --font-label-2:    500 14px/20px 'Geist', ui-sans-serif, system-ui, sans-serif;
  --font-label-3:    500 12px/16px 'Geist', ui-sans-serif, system-ui, sans-serif;
  --font-subhead-cap: 500 12px/16px 'Geist', ui-sans-serif, system-ui, sans-serif;
}

body { font-family: 'Geist', ui-sans-serif, system-ui, sans-serif; }

/* Headings carry the console's tight tracking (UI-THEME §1). */
h1, h2, h3 { letter-spacing: -0.01em; }

/* Verification codes are numbers — mono + tabular, exactly as the console renders every figure. */
input[inputmode='numeric'], input[type='number'] {
  font-family: 'Geist Mono', ui-monospace, monospace;
  font-variant-numeric: tabular-nums;
}
`;

async function token(cfg: BrandingConfig): Promise<string> {
  const basic = Buffer.from(`${cfg.m2mAppId}:${cfg.m2mAppSecret}`).toString('base64');
  const res = await fetch(`${cfg.endpoint}/oidc/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      resource: 'https://default.logto.app/api',
      scope: 'all',
    }),
  });
  if (!res.ok) throw new Error(`logto token failed: ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function api<T>(
  cfg: BrandingConfig,
  tok: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${cfg.endpoint}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`logto ${method} ${path}: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? null : await res.json()) as T;
}

/**
 * Ensure an SMTP email connector exists AND its config is current.
 *
 * `auth` is a REQUIRED field on this connector factory. Omitting it stores a connector that looks
 * fine in a listing but fails every send with a configuration error — which surfaces to the user as
 * "config not done" at the moment they try to sign up. So the config is re-applied on every run
 * rather than skipped when a connector is merely present: a broken one is repaired instead of
 * silently kept.
 */
async function ensureEmailConnector(cfg: BrandingConfig, tok: string): Promise<boolean> {
  if (!cfg.smtpHost) return false;

  const template = (usageType: string, subject: string, content: string) => ({
    usageType,
    subject,
    content,
    contentType: 'text/plain',
  });

  const config = {
    host: cfg.smtpHost,
    port: cfg.smtpPort ?? 1025,
    secure: false,
    fromEmail: cfg.smtpFrom ?? 'relay@localhost',
    // Required by the factory even when the relay does not check it. Mailpit accepts any
    // credentials (MP_SMTP_AUTH_ACCEPT_ANY); a real relay needs its own values here.
    auth: {
      user: cfg.smtpUser ?? 'relay',
      pass: cfg.smtpPassword ?? 'relay',
    },
    templates: [
      template(
        'Register',
        'Your Relay verification code',
        'Your Relay verification code is {{code}}. It expires shortly.\nIf you did not request this, ignore this email.',
      ),
      template('SignIn', 'Your Relay sign-in code', 'Your Relay sign-in code is {{code}}.'),
      template(
        'ForgotPassword',
        'Reset your Relay password',
        'Your Relay password reset code is {{code}}.',
      ),
      // Organization invitations. Logto sends this template when the gateway mails an invitation,
      // and `{{link}}` is the console page that accepts it. WITHOUT this template the send fails and
      // an invited person is never told anything — the invitation just sits in Logto, pending.
      template(
        'OrganizationInvitation',
        'You have been invited to a Relay organization',
        'You have been invited to join an organization on Relay.\n\nAccept the invitation: {{link}}\n\nThe link expires in 7 days. If you were not expecting this, ignore this email.',
      ),
      template('Generic', 'Relay verification code', 'Your Relay code is {{code}}.'),
    ],
  };

  const connectors = await api<{ id: string; type: string }[]>(cfg, tok, 'GET', '/connectors');
  const existing = connectors.find((c) => c.type === 'Email');
  if (existing) {
    await api(cfg, tok, 'PATCH', `/connectors/${existing.id}`, { config });
    return true;
  }

  await api(cfg, tok, 'POST', '/connectors', {
    connectorId: 'simple-mail-transfer-protocol',
    config,
  });
  return true;
}

/** Ensure the sign-up form collects a full name. Referenced by name from signUpProfileFields. */
async function ensureFullnameField(cfg: BrandingConfig, tok: string): Promise<void> {
  const fields = await api<{ name: string }[]>(cfg, tok, 'GET', '/custom-profile-fields');
  if (fields.some((f) => f.name === 'fullname')) return;

  await api(cfg, tok, 'POST', '/custom-profile-fields', {
    name: 'fullname',
    type: 'Fullname',
    label: 'Full name',
    required: true,
    config: {
      parts: [
        { name: 'givenName', type: 'Text', label: 'First name', required: true, enabled: true },
        { name: 'familyName', type: 'Text', label: 'Last name', required: false, enabled: true },
      ],
    },
  });
}

/**
 * Apply the Relay look and the sign-up/sign-in policy.
 *
 * Sign-in keeps BOTH username and email. That is not cosmetic: existing accounts were created with
 * a username and have no email address, so an email-only policy would lock every one of them out
 * the moment it was applied.
 */
export async function brandLogto(cfg: BrandingConfig): Promise<BrandingResult> {
  const tok = await token(cfg);
  const applied: string[] = [];
  const skipped: string[] = [];

  await ensureFullnameField(cfg, tok);
  applied.push('profile-field:fullname');

  const hasEmail = await ensureEmailConnector(cfg, tok);
  if (hasEmail) applied.push('connector:smtp');
  else skipped.push('connector:smtp (no RELAY_SMTP_HOST — email sign-up left unchanged)');

  const patch: Record<string, unknown> = {
    color: {
      primaryColor: PRIMARY_LIGHT,
      darkPrimaryColor: PRIMARY_DARK,
      isDarkModeEnabled: true,
    },
    branding: {
      logoUrl: logoDataUri(PRIMARY_LIGHT),
      darkLogoUrl: logoDataUri(PRIMARY_DARK),
    },
    customCss: CUSTOM_CSS,
    signUpProfileFields: [{ name: 'fullname' }],
  };

  // Only claim email once it can actually be verified; otherwise registration would dead-end.
  if (hasEmail) {
    patch.signUp = { identifiers: ['email'], password: true, verify: true };
    patch.signIn = {
      methods: [
        {
          identifier: 'username',
          password: true,
          verificationCode: false,
          isPasswordPrimary: true,
        },
        { identifier: 'email', password: true, verificationCode: true, isPasswordPrimary: true },
      ],
    };
    patch.forgotPasswordMethods = ['EmailVerificationCode'];
    applied.push(
      'sign-up:email+password+verify',
      'sign-in:username+email',
      'forgot-password:email',
    );
  }

  await api(cfg, tok, 'PATCH', '/sign-in-exp', patch);
  applied.push('theme:relay');

  return { applied, skipped };
}
