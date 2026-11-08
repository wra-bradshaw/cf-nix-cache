import { DurableObject } from 'cloudflare:workers';

export class RpcOnlyDurableObject extends DurableObject<Env> {
  fetch(): Response {
    return Response.json({ code: 'rpc_only' }, { status: 404 });
  }
}
