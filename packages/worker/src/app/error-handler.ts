import { AuthError } from '../features/auth/errors';
import { PublicationError } from '../features/cache/publication-protocol';
import { DomainError } from '../shared/errors';
import { RangeRequestError } from '../features/nix/range';
import { ApiCallError } from '../shared/rpc';

type RequestContext = { get(key: 'requestId'): string };

export function errorResponse(
  c: RequestContext,
  code: string,
  message: string,
  status: number,
): Response {
  return Response.json(
    { code, message, request_id: c.get('requestId') },
    {
      status,
      headers: {
        'cache-control': 'no-store',
        'x-request-id': c.get('requestId'),
      },
    },
  );
}

export function handleError(caught: unknown, c: RequestContext): Response {
  if (caught instanceof AuthError)
    return errorResponse(
      c,
      caught.code,
      caught.message,
      caught.code === 'missing_token' ? 401 : 403,
    );
  if (caught instanceof DomainError || caught instanceof ApiCallError) {
    if (caught.status >= 500)
      console.error({
        request_id: c.get('requestId'),
        code: caught.code,
        error: caught.message,
      });
    return errorResponse(c, caught.code, caught.message, caught.status);
  }
  if (caught instanceof PublicationError)
    return errorResponse(c, caught.code, caught.message, caught.status);
  if (caught instanceof RangeRequestError)
    return errorResponse(c, 'range_not_satisfiable', caught.message, 416);
  // Error objects serialize to `{}` in structured Workers logs.
  console.error({
    request_id: c.get('requestId'),
    error: caught instanceof Error ? (caught.stack ?? caught.message) : caught,
  });
  return errorResponse(c, 'internal_error', 'internal server error', 500);
}
