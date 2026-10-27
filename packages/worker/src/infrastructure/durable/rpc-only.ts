import { DurableObject } from 'cloudflare:workers';

/** Durable Objects in this Worker are reached only through RPC stubs. */
export class RpcOnlyDurableObject extends DurableObject<Env> {
  fetch(): Response {
    return Response.json({ code: 'rpc_only' }, { status: 404 });
  }
}
