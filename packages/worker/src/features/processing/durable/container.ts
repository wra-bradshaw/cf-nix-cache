import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';

const objectStoreHost = 'cache.r2';
const processorPort = 8080;
// How long the container keeps running once the Durable Object is idle.
const inactivityTimeoutMs = 2 * 60 * 1000;
const readyTimeoutMs = 20_000;
const readyPollIntervalMs = 300;
// A probe made before the processor listens can hang instead of failing.
const readyProbeTimeoutMs = 5_000;

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

// The container's requests to http://cache.r2 are routed here, so the
// processor reads and writes R2 without internet access or credentials.
export class ObjectStoreProxy extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> {
    return handleObjectStore(request, this.env);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Under the durable_object scheduling policy each Durable Object starts its
// own container with an image from `ctx.container.images`, which
// @cloudflare/containers does not support, so this drives the runtime API
// directly.
export class ProcessorContainer extends DurableObject<Env> {
  private readonly container: Container;
  // Coalesces concurrent requests: start() throws if a container is running.
  private starting: Promise<void> | undefined;

  constructor(ctx: DurableObjectState<Env>, env: Env) {
    super(ctx, env);
    if (!ctx.container) {
      throw new Error('ProcessorContainer has no container binding');
    }
    this.container = ctx.container;
    // The inactivity timeout does not survive a Durable Object restart (for
    // example after a deploy) even when the container keeps running.
    if (this.container.running) {
      void ctx.blockConcurrencyWhile(() =>
        this.container.setInactivityTimeout(inactivityTimeoutMs),
      );
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (!this.container.running) {
      this.starting ??= this.start().finally(() => {
        this.starting = undefined;
      });
    }
    await this.starting;
    // Callers may address the processor as https://, but container ports
    // only accept plain HTTP (the connection is already private).
    const url = new URL(request.url);
    url.protocol = 'http:';
    return this.container
      .getTcpPort(processorPort)
      .fetch(new Request(url, request));
  }

  private async start(): Promise<void> {
    const image = this.container.images.processor;
    if (!image) {
      throw new Error('wrangler.jsonc defines no "processor" container image');
    }
    // Intercepts end with the container, and with internet access disabled a
    // DNS lookup for cache.r2 fails until it is registered, so register it
    // before every start.
    await this.container.interceptOutboundHttp(
      objectStoreHost,
      this.ctx.exports.ObjectStoreProxy,
    );
    this.container.start({
      image,
      enableInternet: false,
      env: { OBJECT_STORE_ENDPOINT: `http://${objectStoreHost}` },
    });
    await this.container.setInactivityTimeout(inactivityTimeoutMs);
    await this.waitUntilReady();
  }

  // start() returns before the processor accepts connections.
  private async waitUntilReady(): Promise<void> {
    const port = this.container.getTcpPort(processorPort);
    const deadline = Date.now() + readyTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const response = await port.fetch('http://processor/ready', {
          signal: AbortSignal.timeout(readyProbeTimeoutMs),
        });
        await response.body?.cancel();
        if (response.ok) return;
        lastError = new Error(`processor /ready returned ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      if (!this.container.running) {
        throw new Error('processor container exited during startup', {
          cause: lastError,
        });
      }
      await delay(readyPollIntervalMs);
    }
    throw new Error(
      `processor was not ready within ${readyTimeoutMs / 1000}s`,
      { cause: lastError },
    );
  }
}
