import { Container } from '@cloudflare/containers';

const objectStoreHost = 'cache.r2';

async function handleObjectStore(
  request: Request,
  env: Pick<Env, 'CACHE_BUCKET'>,
): Promise<Response> {
  const url = new URL(request.url);
  let key: string;
  try {
    key = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return new Response('Invalid object key', { status: 400 });
  }
  if (!key) return new Response('Object key is required', { status: 400 });

  if (request.method === 'GET') {
    const object = await env.CACHE_BUCKET.get(key);
    if (!object) return new Response('Not found', { status: 404 });
    return new Response(object.body, {
      headers: object.httpMetadata?.contentType
        ? { 'content-type': object.httpMetadata.contentType }
        : undefined,
    });
  }

  if (request.method === 'PUT') {
    const object = await env.CACHE_BUCKET.put(
      key,
      request.body ?? new Uint8Array(),
      {
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: {
          contentType:
            request.headers.get('content-type') ?? 'application/octet-stream',
        },
      },
    );
    return new Response(null, { status: object ? 201 : 412 });
  }

  return new Response('Method not allowed', {
    status: 405,
    headers: { allow: 'GET, PUT' },
  });
}

export class ProcessorContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '2m';
  enableInternet = false;

  constructor(ctx: DurableObjectState<Env>, env: Env) {
    super(ctx, env);
    this.envVars = { OBJECT_STORE_ENDPOINT: `http://${objectStoreHost}` };
  }

  override fetch(request: Request): Promise<Response> {
    return this.containerFetch(request);
  }
}

ProcessorContainer.outboundByHost = {
  [objectStoreHost]: handleObjectStore,
};
