// The operator event stream.
//
// One place owns which responses are listening, so any ingest path — the desktop bridge or a
// signed-in phone relay — can report an observation to the same session without a second
// copy of the fan-out. Events are scoped by owner: an operator only ever receives their own
// relays' telemetry.

import type { Response } from "express";

const streamClients = new Map<Response, string>();

export function registerStreamClient(res: Response, ownerId: string): void {
  streamClients.set(res, ownerId);
}

export function unregisterStreamClient(res: Response): void {
  streamClients.delete(res);
}

/** Writes one server-sent event to every listener of this owner (or to all when omitted). */
export function emit(event: string, payload: unknown, ownerId?: string): void {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const [client, clientOwnerId] of streamClients) {
    if (ownerId && clientOwnerId !== ownerId) continue;
    try {
      client.write(message);
    } catch {
      streamClients.delete(client);
    }
  }
}
