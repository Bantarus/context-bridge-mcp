// ─── Errors ──────────────────────────────────────────────────────────────────
//
// Bridge code throws BridgeError; each front end maps it to its own shape
// (an MCP error code, or a CLI exit code). Keeping the MCP SDK out of this
// module lets the CLI start without loading it.

export type ErrorKind = "invalid_params" | "internal" | "not_found";

export class BridgeError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export const invalidParams = (message: string) => new BridgeError("invalid_params", message);
export const internalError = (message: string) => new BridgeError("internal", message);
