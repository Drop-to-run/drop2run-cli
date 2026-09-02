import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_FILE, readProject, writeProject } from "../src/project.js";

/**
 * `drop2run.json`: the file that decides which site a folder publishes to.
 *
 * What is worth asserting is the refusal to guess. Every command that reads this file acts on a site,
 * and two of them — `rm` and `rollback` — act destructively, so a file that is missing, truncated or
 * half-written has to read as "no project" rather than as a project pointing somewhere unintended.
 */

/** A fresh empty directory to write a project file into. */
function scratch(): string {
	return mkdtempSync(join(tmpdir(), "drop2run-project-"));
}

describe("writeProject", () => {
	it("writes what readProject reads back", () => {
		const directory = scratch();

		writeProject({ siteId: "01J", subdomain: "calm-cedar", dir: "dist" }, directory);

		expect(readProject(directory)).toEqual({
			siteId: "01J",
			subdomain: "calm-cedar",
			dir: "dist",
		});
	});

	it("writes something a person can read and edit", () => {
		const directory = scratch();

		writeProject({ siteId: "01J", subdomain: "calm-cedar", dir: "dist" }, directory);

		const written = readFileSync(join(directory, PROJECT_FILE), "utf8");

		// Indented and newline-terminated: this file goes into code review, and a shell appending to it
		// should not produce a broken last line.
		expect(written).toContain('\n\t"siteId"');
		expect(written.endsWith("\n")).toBe(true);
	});
});

describe("readProject", () => {
	it("reports no project when there is no file", () => {
		expect(readProject(scratch())).toBeNull();
	});

	it("treats a malformed file as no project rather than throwing", () => {
		const directory = scratch();
		writeFileSync(join(directory, PROJECT_FILE), "{ not json");

		// A stray comma should leave `deploy` unconfigured, not unusable.
		expect(readProject(directory)).toBeNull();
	});

	it("refuses a file with no siteId, which is not a project", () => {
		const directory = scratch();
		writeFileSync(join(directory, PROJECT_FILE), JSON.stringify({ dir: "dist" }));

		// The important half: reading this as a project would send a publish to a site chosen by accident.
		expect(readProject(directory)).toBeNull();
	});

	it("defaults the folder to the project root when the file names none", () => {
		const directory = scratch();
		writeFileSync(join(directory, PROJECT_FILE), JSON.stringify({ siteId: "01J" }));

		expect(readProject(directory)?.dir).toBe(".");
	});
});
