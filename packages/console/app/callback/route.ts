import { NextResponse, type NextRequest } from 'next/server';
import { handleSignIn } from '@logto/next/server-actions';
import { logtoConfig } from '../lib/logto';

/** Logto redirects here after sign-in. Complete the exchange, then return to the home page. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  await handleSignIn(logtoConfig, request.nextUrl.searchParams);
  return NextResponse.redirect(new URL('/', request.url));
}
