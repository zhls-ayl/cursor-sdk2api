import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { forbiddenError } from "../errors.js";

/** Operator UI and unauthenticated account-pool mutations stay on loopback even when the API listens on LAN. */
export function isOperatorSurface(pathname: string): boolean {
  return (
    pathname === "/console" ||
    pathname.startsWith("/console/") ||
    pathname === "/v0/management" ||
    pathname.startsWith("/v0/management/")
  );
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  let host = address.trim();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const zone = host.indexOf("%");
  if (zone >= 0) host = host.slice(0, zone);
  if (host.startsWith("::ffff:")) host = host.slice(7);
  if (host === "localhost" || host === "::1") return true;
  if (isIP(host) === 4) {
    const octet = Number(host.split(".")[0]);
    return octet === 127;
  }
  return false;
}

export function requireLoopbackOperator(req: IncomingMessage, pathname: string): void {
  if (!isOperatorSurface(pathname)) return;
  if (isLoopbackAddress(req.socket.remoteAddress)) return;
  throw forbiddenError("Operator console and management API are loopback-only.");
}
