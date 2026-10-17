import { problemTraceId } from "@drop2run/core";

/**
 * Pointing somebody who hit a failure at the page that reports it.
 *
 * The CLI and the MCP server print errors where nobody can attach a screenshot, and until now the only
 * route to us was the package's issue tracker. A failed API call already knows what a report needs — its
 * code and the id the API logged it under — so this hands both to the report page in its query string,
 * and the page fills them in rather than asking the person to copy them.
 *
 * Portable, like the API client: the remote MCP Worker uses it too, and has no disk.
 */

/** What a report of one failure carries, read off whatever was thrown. */
export interface FailureContext {
	/** The API's code, or a client-side one, or null when the error has none. */
	readonly code: string | null;
	/** The id the API logged the request under, or null when the failure did not come from the API. */
	readonly traceId: string | null;
}

/** Which surface printed the link, so a report says where it came from. */
export type ReportSource = "cli" | "mcp";

/**
 * Reads the code and trace id off an error, from either shape that carries them.
 *
 * A call made by the API client throws an `ApiFailure`, with both on the error itself. A publish throws
 * the engine's `DeployError`, whose `detail` is the problem body the trace id is in.
 *
 * @param error Whatever was thrown.
 * @returns The context, with null for whatever it does not carry.
 */
export function failureContext(error: unknown): FailureContext {
	if (typeof error !== "object" || error === null) return { code: null, traceId: null };

	const { code, traceId, detail } = error as {
		code?: unknown;
		traceId?: unknown;
		detail?: unknown;
	};

	return {
		code: typeof code === "string" && code !== "" ? code : null,
		traceId: typeof traceId === "string" && traceId !== "" ? traceId : problemTraceId(detail),
	};
}

/**
 * API codes that answer the question correctly rather than report a fault, so no report link goes under
 * them.
 *
 * `owner_only` is a member being told, correctly, that an owner has to do this. The API logs it with a
 * trace id like every response, so before this a member who ran `delete_site` got the right answer and
 * then a link inviting them to report it as our bug.
 */
const ANSWERS_NOT_FAULTS: ReadonlySet<string> = new Set(["owner_only"]);

/**
 * The address of the report page, filled in for one failure.
 *
 * Only for a failure the API logged. A refusal made here — a missing `index.html`, a folder over the
 * plan's size — is the person's to fix, and a report link under it reads as "this is our fault". The
 * same goes for an API refusal that is the right answer ({@link ANSWERS_NOT_FAULTS}).
 *
 * @param dashboardOrigin The dashboard's origin (`dashboardUrlFor`), where the report page is.
 * @param context What the failure carries.
 * @param source Which surface is printing it.
 * @returns The URL, or null when the failure has no trace id.
 */
export function reportLink(
	dashboardOrigin: string,
	context: FailureContext,
	source: ReportSource,
): string | null {
	if (context.traceId === null) return null;
	if (context.code !== null && ANSWERS_NOT_FAULTS.has(context.code)) return null;

	const url = new URL("/report", dashboardOrigin);
	if (context.code !== null) url.searchParams.set("code", context.code);
	url.searchParams.set("trace", context.traceId);
	url.searchParams.set("source", source);

	return url.toString();
}
