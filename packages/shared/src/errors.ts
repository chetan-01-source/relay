/**
 * Relay error-code catalog — single source of truth (PRD §15: "error codes added to the catalog").
 * Wire format mirrors OpenAI's error envelope so client SDKs treat Relay errors as native.
 */
export const ErrorCode = {
  invalid_api_key: 'invalid_api_key',
  key_revoked: 'key_revoked',
  org_suspended: 'org_suspended',
  rate_limited: 'rate_limited',
  budget_exceeded: 'budget_exceeded',
  model_capability_mismatch: 'model_capability_mismatch',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface RelayError {
  code: ErrorCode;
  message: string;
  httpStatus: number;
}

export function relayError(code: ErrorCode, message: string, httpStatus: number): RelayError {
  return { code, message, httpStatus };
}
