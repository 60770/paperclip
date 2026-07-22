import { createServer, type Server, type ServerOptions } from "node:https";
import { TLSSocket } from "node:tls";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ReleaseBroker } from "./broker.js";
import { asBrokerError, BrokerError } from "./errors.js";
import { parseCapabilityRequest, parseJsonBody, parseMergeCapabilityRequest } from "./validation.js";

const MAX_BODY_BYTES = 8192;

export function createBrokerServer(tls: ServerOptions, broker: ReleaseBroker): Server {
  return createServer(tls, async (request, response) => {
    const transportRequestId = randomUUID();
    let identity = "unverified";
    let brokerInvoked = false;
    try {
      identity = clientIdentity(request);
      if (request.method === "GET" && request.url === "/healthz") {
        writeJson(response, 200, { status: "ok" });
        return;
      }
      if (request.method !== "POST" || (request.url !== "/v1/capabilities" && request.url !== "/v1/merge")) {
        throw new BrokerError("invalid_request", 404);
      }
      const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
      if (contentType !== "application/json") throw new BrokerError("invalid_request", 400);
      const body = parseJsonBody(await readBody(request));
      if (request.url === "/v1/capabilities") {
        const input = parseCapabilityRequest(body);
        brokerInvoked = true;
        writeJson(response, 201, await broker.requestCapability(identity, input));
      } else {
        const input = parseMergeCapabilityRequest(body);
        brokerInvoked = true;
        writeJson(response, 200, await broker.merge(identity, input));
      }
    } catch (error) {
      let brokerError = asBrokerError(error);
      if (!brokerInvoked) {
        try {
          await broker.auditBoundaryDenial(identity, transportRequestId, brokerError.code);
        } catch (auditError) {
          brokerError = asBrokerError(auditError);
        }
      }
      writeJson(response, brokerError.status, { error: brokerError.code });
    }
  });
}

function clientIdentity(request: IncomingMessage): string {
  if (!(request.socket instanceof TLSSocket) || !request.socket.authorized) {
    throw new BrokerError("client_denied", 403);
  }
  const fingerprint = request.socket.getPeerCertificate(false).fingerprint256;
  if (!fingerprint) throw new BrokerError("client_denied", 403);
  const normalized = fingerprint.replaceAll(":", "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new BrokerError("client_denied", 403);
  return `sha256:${normalized}`;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const declaredLength = Number(request.headers["content-length"] ?? "0");
  if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > MAX_BODY_BYTES) {
    throw new BrokerError("invalid_request", 400);
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new BrokerError("invalid_request", 400);
    chunks.push(chunk);
  }
  if (declaredLength !== 0 && declaredLength !== length) throw new BrokerError("invalid_request", 400);
  return Buffer.concat(chunks, length);
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": encoded.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(encoded);
}
