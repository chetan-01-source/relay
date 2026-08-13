import { NextResponse, type NextRequest } from 'next/server';
import { handleSignIn } from '@logto/next/server-actions';
import { logtoConfig } from '../lib/logto';
import { takeReturnTo } from '../lib/return-to';

/**
 * Logto redirects here after sign-in. Complete the exchange, then return the user to wherever they
 * were headed — an invitation page they opened while signed out, or the home page by default. The
 * destination is a same-site path parked in a one-shot cookie (see lib/return-to.ts).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  await handleSignIn(logtoConfig, request.nextUrl.searchParams);
  const returnTo = await takeReturnTo();
  return NextResponse.redirect(new URL(returnTo ?? '/', request.url));
}
