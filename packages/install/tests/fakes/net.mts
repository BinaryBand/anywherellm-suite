// Starting and stopping a server on a free port of this machine.
import type http from "node:http";
import type { AddressInfo } from "node:net";

export function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

export async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
