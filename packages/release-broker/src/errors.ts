export type BrokerErrorCode =
  | "ambiguous_response"
  | "attestation_failed"
  | "audit_failed"
  | "capability_expired"
  | "capability_invalid"
  | "capability_replayed"
  | "client_denied"
  | "company_mismatch"
  | "human_gate_blocked"
  | "invalid_request"
  | "main_lock_active"
  | "merge_failed"
  | "mr_not_ready"
  | "paperclip_not_ready"
  | "request_replayed"
  | "sha_mismatch"
  | "upstream_failed";

export class BrokerError extends Error {
  readonly code: BrokerErrorCode;
  readonly status: number;

  constructor(code: BrokerErrorCode, status: number, message = code) {
    super(message);
    this.name = "BrokerError";
    this.code = code;
    this.status = status;
  }
}

export function asBrokerError(error: unknown): BrokerError {
  if (error instanceof BrokerError) return error;
  return new BrokerError("upstream_failed", 503);
}
