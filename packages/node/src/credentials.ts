/**
 * What a call to the control plane needs, with nothing about where it was stored.
 *
 * <b>Split from `config.ts` so that a runtime with no disk can import it.</b> The API client needs the
 * shape of a credential and the dashboard origin that goes with a base URL; it does not need the config
 * file those usually come from. Kept together with the file they would import `node:fs`, and the
 * remote MCP Worker — which holds each user's token in the grant it issued, not in a file — could not
 * bundle the API client at all.
 */

/** Everything the server needs to talk to the control plane. */
export interface Credentials {
	/** The token to send as a bearer credential. */
	readonly token: string;
	/** Base URL of the API. */
	readonly apiBaseUrl: string;
	/**
	 * Extra headers for every call to the API and nothing else. The remote MCP Worker's service key travels
	 * here; the local server and the CLI leave it unset.
	 */
	readonly headers?: Readonly<Record<string, string>>;
}

/** The API this server talks to unless told otherwise. */
export const DEFAULT_API_BASE_URL = "https://dropto.run/api";

/**
 * Production's marketing origin, which still proxies the API so released command lines keep working, but
 * no longer serves the dashboard.
 */
const PRODUCTION_SITE_ORIGIN = "https://dropto.run";

/** The origin production's dashboard moved to: sign-in, consent, account and site pages. */
const PRODUCTION_DASHBOARD_ORIGIN = "https://app.dropto.run";

/**
 * The dashboard origin that goes with an API base URL.
 *
 * Derived rather than configured separately, because the two are the same deployment and a second setting
 * is a second thing to get wrong: somebody who points the API at a local instance and then opens a consent
 * page on production has signed a local command line in against the wrong account, which is confusing in
 * exactly the way credentials should not be.
 *
 * The API lives under `/api` on the dashboard origin (see plan §4), so this is that path removed — with
 * one exception. Production's dashboard moved to its own host while `https://dropto.run/api` stayed, so
 * that origin maps to the dashboard's host. The old paths there redirect too, but only after loading a
 * page first, and a consent link printed in a terminal is worth getting right the first time.
 *
 * @param apiBaseUrl The API base URL.
 * @returns The origin the browser should be sent to.
 */
export function dashboardUrlFor(apiBaseUrl: string): string {
	const origin = apiBaseUrl.replace(/\/+$/, "").replace(/\/api$/, "");

	return origin === PRODUCTION_SITE_ORIGIN ? PRODUCTION_DASHBOARD_ORIGIN : origin;
}
