/** Single source of the gateway's release version — used by the CLI (`relay --version`) and surfaced
 * on the internal /readyz probe so operators (and the console Status page) can confirm what's running.
 * Bumped in lockstep with the published image tag. */
export const RELAY_VERSION = '0.2.0';
