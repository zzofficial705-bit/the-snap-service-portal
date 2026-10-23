import { NextResponse } from 'next/server';
import crypto from 'crypto';

/**
 * Generates an HTTP entity tag (ETag) for data payloads.
 */
export function createETag(data: unknown): string {
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  const hash = crypto.createHash('md5').update(str).digest('hex');
  return `"${hash}"`;
}

export interface ConditionalGetOptions {
  maxAge?: number;
  staleWhileRevalidate?: number;
  extraHeaders?: Record<string, string>;
}

/**
 * Handles HTTP Conditional GET requests with ETag and 304 Not Modified.
 * If incoming If-None-Match matches the computed ETag, sends a 304 response with 0 body bytes.
 */
export function handleConditionalGet(
  request: Request,
  data: unknown,
  options?: ConditionalGetOptions
): NextResponse {
  const etag = createETag(data);
  const clientEtag = request.headers.get('if-none-match');

  const maxAge = options?.maxAge ?? 0;
  const swr = options?.staleWhileRevalidate ?? 60;
  const cacheControl = maxAge > 0
    ? `public, max-age=${maxAge}, stale-while-revalidate=${swr}`
    : 'no-cache, must-revalidate';

  const baseHeaders: Record<string, string> = {
    'ETag': etag,
    'Cache-Control': cacheControl,
    ...(options?.extraHeaders || {}),
  };

  // Compare ETags (handling weak W/ prefix if sent by client/proxy)
  if (clientEtag) {
    const cleanClient = clientEtag.replace(/^W\//, '').trim();
    const cleanServer = etag.replace(/^W\//, '').trim();
    if (cleanClient === cleanServer || cleanClient === '*' || clientEtag === etag) {
      return new NextResponse(null, {
        status: 304,
        headers: baseHeaders,
      });
    }
  }

  return NextResponse.json(data, {
    status: 200,
    headers: baseHeaders,
  });
}
