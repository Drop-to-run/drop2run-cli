import { describe, expect, it } from "vitest";
import type { SiteDetail, SiteUpstreams } from "../src/api.js";
import { accessOf, describeSite, describeUpstreams, servingModeOf } from "../src/describe.js";

/**
 * How a site's settings read in `drop2run info` and the MCP server's `get_site`.
 */

/** A site with every setting at its plain default, for a test to override. */
const SITE: SiteDetail = {
	siteId: "01J",
	subdomain: "calm-cedar",
	url: "https://calm-cedar.dropto.live",
	name: null,
	status: "active",
	invitedOnly: false,
	liveDeployId: "01B",
	spaMode: false,
	docsMode: false,
	modeIsManual: true,
	passwordProtected: false,
	passwordProtectionAvailable: true,
	formsEnabled: false,
	formsAvailable: true,
	expiresAt: null,
	expiryAction: "pause",
	scheduledExpiryAvailable: true,
	comments: "off",
	commentsAvailable: true,
	folderId: null,
	subdomainChangesLeft: 2,
	formerSubdomains: [],
	deploys: [
		{
			deployId: "01B",
			status: "live",
			fileCount: 3,
			totalBytes: 10,
			createdAt: "2026-10-06T00:00:00Z",
			completedAt: "2026-10-06T00:00:01Z",
			filesKept: true,
		},
		{
			deployId: "01A",
			status: "superseded",
			fileCount: 2,
			totalBytes: 8,
			createdAt: "2026-10-05T00:00:00Z",
			completedAt: "2026-10-05T00:00:01Z",
			filesKept: false,
		},
	],
};

describe("describeSite", () => {
	it("marks the version being served, and only that one", () => {
		const lines = describeSite(SITE).split("\n");

		expect(lines.find((line) => line.includes("01B"))).toContain("← served");
		expect(lines.find((line) => line.includes("01A"))).not.toContain("← served");
	});

	it("never calls a site public when whether it is invite-only could not be read", () => {
		// The second request can fail, or meet an API that predates sharing. "Public" on that guess is
		// the one wrong answer that would have somebody share a link they think is open.
		expect(accessOf({ passwordProtected: false, invitedOnly: null })).not.toBe("public");
		expect(accessOf({ passwordProtected: false, invitedOnly: true })).toBe("invite-only");
		expect(accessOf({ passwordProtected: false, invitedOnly: false })).toBe("public");
		expect(accessOf({ passwordProtected: true, invitedOnly: false })).toBe("password");
		expect(describeSite({ ...SITE, invitedOnly: true })).toMatch(/access\s+invite-only/);
	});

	it("says when a version can no longer be rolled back to", () => {
		expect(describeSite(SITE)).toContain("files collected");
	});

	it("says a setting is not on the plan, rather than only that it is off", () => {
		// "off" alone reads as something that can be switched on; the refusal that follows trying is a
		// worse way to find out.
		const text = describeSite({ ...SITE, passwordProtectionAvailable: false });

		expect(text).toMatch(/password\s+off \(not on this plan\)/);
		expect(text).not.toMatch(/forms\s+off \(not on this plan\)/);
	});

	it("names the folder by path when the caller looked it up", () => {
		expect(describeSite({ ...SITE, folderId: "01F" }, "Clients/Acme")).toContain("Clients/Acme");
		expect(describeSite(SITE)).toContain("(top level)");
	});
});

describe("servingModeOf", () => {
	it("reads the two switches as one of three modes", () => {
		expect(servingModeOf({ spaMode: true, docsMode: false })).toBe("spa");
		expect(servingModeOf({ spaMode: false, docsMode: true })).toBe("docs");
		expect(servingModeOf({ spaMode: false, docsMode: false })).toBe("static");
	});
});

describe("describeUpstreams", () => {
	/** A Pro month part used, one upstream and one route. */
	const API: SiteUpstreams = {
		upstreams: [
			{
				id: "up1",
				origin: "https://api.openai.com",
				methods: ["GET", "POST"],
				headers: [{ name: "authorization", last4: "Wq9z" }],
				blocked: false,
			},
		],
		limit: 5,
		proxyBlocked: false,
		routes: [{ from: "/api/*", to: "https://api.openai.com/v1/:splat" }],
		allowance: {
			perMonth: 1_000_000,
			used: 182_400,
			suspended: false,
			resetsAt: "2026-11-01T00:00:00Z",
		},
	};

	it("says nothing where the proxy is not available, so such a site reads as it always did", () => {
		expect(describeUpstreams(null)).toEqual([]);
		expect(describeSite(SITE)).not.toContain("api ");
	});

	it("lists the month, each upstream by header name and last four characters, and the routes", () => {
		expect(describeUpstreams(API)).toEqual([
			"  api       182,400 of 1,000,000 requests this month, every site of the account",
			"    https://api.openai.com  GET, POST; authorization ••••Wq9z",
			"    route /api/* → https://api.openai.com/v1/:splat",
		]);
	});

	it("says why calls fail: a plan without it, a spent month, a platform switch, a blocked origin", () => {
		expect(
			describeUpstreams({
				...API,
				upstreams: [],
				routes: [],
				allowance: { ...API.allowance, perMonth: 0 },
			}),
		).toEqual(["  api       off (not on this plan)"]);
		expect(
			describeUpstreams({ ...API, allowance: { ...API.allowance, suspended: true } })[0],
		).toContain("calls answer 429 until 2026-11-01");
		expect(describeUpstreams({ ...API, proxyBlocked: true })[0]).toContain(
			"switched off by Drop2Run",
		);
		const first = API.upstreams[0];
		if (first === undefined) throw new Error("fixture");
		expect(describeUpstreams({ ...API, upstreams: [{ ...first, blocked: true }] })[1]).toContain(
			"calls answer 502",
		);
	});
});
