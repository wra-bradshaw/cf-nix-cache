import { AuthError } from '../auth/errors';
import { PublicationError } from '../cache/application';
import { DomainError } from '../domain/validation';
import { RangeRequestError } from '../nix/range';
import { ApiCallError } from '../../rpc';

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
  if (caught instanceof DomainError)
    return errorResponse(c, caught.code, caught.message, caught.status);
  if (caught instanceof ApiCallError)
    return errorResponse(c, caught.code, caught.message, caught.status);
  if (caught instanceof PublicationError)
    return errorResponse(
      c,
      'retryable_failure',
      caught.message,
      caught.retryable ? 503 : 409,
    );
  if (caught instanceof RangeRequestError)
    return errorResponse(c, 'range_not_satisfiable', caught.message, 416);
  console.error({ request_id: c.get('requestId'), error: caught });
  return errorResponse(c, 'internal_error', 'internal server error', 500);
}
