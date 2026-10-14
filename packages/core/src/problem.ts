/**
 * Reading the two members of an RFC 9457 body that every client of the API needs the same way.
 *
 * Three places read a problem body — the dashboard's `readProblem`, this package's deploy calls, and the
 * CLI's request helper — and each used to decide for itself what the code was. They agreed only because
 * nobody had looked at a body the API's own error table did not write.
 */

/**
 * The stable code of a refusal, or `http_<status>` when the body does not carry one.
 *
 * The API's own refusals name their code in `type` (`quota_exceeded`, `unsafe_path`, …). Anything the
 * framework answers by itself — an unhandled exception through `UseExceptionHandler`, a bare status
 * through `UseStatusCodePages` — fills `type` with the RFC's own address instead,
 * `https://tools.ietf.org/html/rfc9110#section-15.6.1` for a 500. Measured 14/10/2026. Shown as a code,
 * that is a URL on an error card and in a support report, so anything carrying a URI scheme counts as no
 * code at all.
 *
 * @param type The body's `type`, whatever it holds.
 * @param status The response's HTTP status.
 * @returns A code safe to branch on and to show.
 */
export function problemCode(type: unknown, status: number): string {
	return typeof type === "string" && type !== "" && !/^[a-z][a-z0-9+.-]*:/i.test(type)
		? type
		: `http_${status}`;
}

/**
 * The id the API logged this request under, when the body carries one.
 *
 * ASP.NET Core adds `traceId` to every problem body it writes, as a W3C id (`00-{trace}-{span}-00`).
 * Shown to the person who hit the error so a report can quote it; the runbook says how to find the log
 * line from it.
 *
 * @param body A parsed problem body, or anything else.
 * @returns The id, or null when there is none.
 */
export function problemTraceId(body: unknown): string | null {
	if (typeof body !== "object" || body === null) return null;

	const value = (body as Record<string, unknown>).traceId;

	return typeof value === "string" && value !== "" ? value : null;
}
