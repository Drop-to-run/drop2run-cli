import type { ProgressEvent } from "@drop2run/core";
import { expect, describe as group, it } from "vitest";
import { describe, formatBytes, progressWriter, shortenPath } from "../src/progress.js";

/**
 * What a deploy shows while it runs.
 *
 * <b>The rule being guarded is that one line stays one line.</b> Progress that wraps is worse than no
 * progress: the terminal scrolls, every rewrite lands on a fresh row, and what the person is left with
 * is a column of half-finished counters instead of the single moving line the feature exists to give
 * them. So the filename is the part that gets cut, and it gets cut against the width it is given.
 *
 * <b>And that a pipe is not a terminal.</b> Carriage returns in a CI log are unreadable, and one line
 * per uploaded file is thousands of lines nobody scrolls through. Redirected, only stage changes print.
 */

/** An `uploading` event, with the parts a test cares about filled in. */
function uploading(over: Partial<Extract<ProgressEvent, { type: "uploading" }>>): ProgressEvent {
	return { type: "uploading", done: 1, total: 10, bytes: 1024, reused: 0, ...over };
}

group("describe", () => {
	it("counts the whole deploy rather than the upload", () => {
		const line = describe(uploading({ done: 498, total: 500, reused: 495 }));

		expect(line).toContain("498/500");
		expect(line).toContain("495 already there");
	});

	it("says nothing about reuse when nothing was reused", () => {
		expect(describe(uploading({ reused: 0 }))).not.toContain("already there");
	});

	it("names the file that just landed", () => {
		expect(describe(uploading({ path: "assets/app.css" }))).toContain("assets/app.css");
	});

	it("keeps the line inside the width it is given", () => {
		const line = describe(uploading({ path: "a".repeat(300) }), 80);

		expect(line).not.toBeNull();
		expect((line as string).length).toBeLessThanOrEqual(80);
	});

	it("drops the filename rather than the counts when the width is tiny", () => {
		const line = describe(uploading({ done: 3, total: 9, path: "assets/app.css" }), 30);

		expect(line).toContain("3/9");
		expect(line).not.toContain("app.css");
	});

	it("says nothing for the events that end the deploy", () => {
		// The command prints the URL from the result it returns. Saying it here too prints it twice.
		expect(describe({ type: "done", url: "https://x.dropto.live", name: null })).toBeNull();
		expect(describe({ type: "unchanged", url: "https://x.dropto.live" })).toBeNull();
		expect(describe({ type: "error", code: "upload_failed", message: "no" })).toBeNull();
	});

	it("counts one file as a file", () => {
		expect(describe({ type: "collecting", files: 1 })).toBe("Collected 1 file");
		expect(describe({ type: "collecting", files: 2 })).toBe("Collected 2 files");
	});
});

group("formatBytes", () => {
	it("counts in the largest unit that fits", () => {
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(1024)).toBe("1.0 KB");
		expect(formatBytes(1024 * 1024 * 3.5)).toBe("3.5 MB");
	});
});

group("shortenPath", () => {
	it("keeps the tail, which is the part that identifies the file", () => {
		// Written out rather than computed from the input: a test that slices the same string the code
		// slices moves whenever the code does, and agrees with it either way.
		expect(shortenPath("assets/vendor/deep/app.css", 12)).toBe("…eep/app.css");
		expect(shortenPath("app.css", 12)).toBe("app.css");
	});
});

group("progressWriter", () => {
	it("rewrites one line on a terminal", () => {
		const written: string[] = [];
		const report = progressWriter((text) => written.push(text), true, 80);

		report({ type: "collecting", files: 3 });
		report({ type: "hashing", done: 1, total: 3 });

		expect(written).toHaveLength(2);
		expect(written.every((text) => text.startsWith("\r"))).toBe(true);
		expect(written.some((text) => text.includes("\n"))).toBe(false);
	});

	it("pads over the longer line it replaces, so no tail is left behind", () => {
		const written: string[] = [];
		const report = progressWriter((text) => written.push(text), true, 80);

		report({ type: "preparing" });
		report({ type: "completing", reused: 0 });

		// "Publishing" is far shorter than the line before it; without the padding the end of that line
		// would still be on screen, reading as part of the new one.
		expect(written[1]).toMatch(/Publishing {2,}$/);
	});

	it("clears the line when the deploy ends", () => {
		const written: string[] = [];
		const report = progressWriter((text) => written.push(text), true, 80);

		report({ type: "preparing" });
		report.done();

		expect(written[1]).toMatch(/^\r +\r$/);
	});

	it("prints one line per stage when it is not a terminal", () => {
		const written: string[] = [];
		const report = progressWriter((text) => written.push(text), false, 80);

		report(uploading({ done: 1 }));
		report(uploading({ done: 2 }));
		report(uploading({ done: 3 }));
		report({ type: "completing", reused: 0 });
		report.done();

		expect(written).toHaveLength(2);
		expect(written.every((text) => text.endsWith("\n"))).toBe(true);
		expect(written.some((text) => text.includes("\r"))).toBe(false);
	});
});
