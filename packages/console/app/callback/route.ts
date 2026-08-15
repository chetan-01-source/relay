import { NextResponse, type NextRequest } from 'next/server';
import { handleSignIn } from '@logto/next/server-actions';
import { logtoConfig } from '../lib/logto';
import { takeReturnTo } from '../lib/return-to';
import { diagnoseSignInFailure, originFromHeaders } from '../lib/signin-diagnostics';

/**
 * Logto redirects here after sign-in. Complete the exchange, then return the user to wherever they
 * were headed — an invitation page they opened while signed out, or the home page by default. The
 * destination is a same-site path parked in a one-shot cookie (see lib/return-to.ts).
 *
 * The failure path is deliberately verbose. Logto reports a missing sign-in cookie as
 * `sign_in_session.not_found`, which describes the symptom and not the cause; unhandled, it surfaces
 * as a bare 500 and a stack trace pointing at this line. The usual cause is an origin mismatch —
 * the console opened on a LAN IP while LOGTO_BASE_URL still says localhost — which is invisible in
 * that message but trivial to detect here, because we can compare the two.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await handleSignIn(logtoConfig, request.nextUrl.searchParams);
  } catch (error) {
    const diagnosis = diagnoseSignInFailure(
      originFromHeaders(request.headers, logtoConfig.baseUrl),
      logtoConfig.baseUrl,
      error,
    );
    // Logged for the terminal, where whoever is running `make dev` is already looking.
    console.error(`[relay] ${diagnosis.title}\n${diagnosis.detail}`);
    // 400, not 500: every cause here is a bad or stale request, not a broken server.
    return new NextResponse(renderFailure(diagnosis.title, diagnosis.detail), {
      status: 400,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  const returnTo = await takeReturnTo();
  return NextResponse.redirect(new URL(returnTo ?? '/', request.url));
}

/**
 * A minimal self-contained page. No imports from the design system: this renders when sign-in is
 * broken, so it must not depend on anything that might itself be misconfigured — and it has to be
 * legible in whichever theme the browser is in.
 */
function renderFailure(title: string, detail: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign-in failed — Relay</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; padding:3rem 1.5rem; font:16px/1.6 ui-sans-serif,system-ui,sans-serif;
         display:flex; justify-content:center; }
  main { max-width:44rem; }
  h1 { font-size:1.25rem; line-height:1.4; margin:0 0 1rem; }
  pre { white-space:pre-wrap; font:14px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;
        padding:1rem; border-radius:.5rem; border:1px solid; border-color:color-mix(in srgb, currentColor 20%, transparent);
        background:color-mix(in srgb, currentColor 5%, transparent); }
  a { color:inherit; }
</style></head>
<body><main>
  <h1>${escapeHtml(title)}</h1>
  <pre>${escapeHtml(detail)}</pre>
  <p><a href="/">Back to the console</a></p>
</main></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
