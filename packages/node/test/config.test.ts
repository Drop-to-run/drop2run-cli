import { describe, expect, it } from "vitest";
import {
	DEFAULT_API_BASE_URL,
	loadCredentials,
	missingCredentialsMessage,
	TOKEN_VARIABLE,
} from "../src/config.js";

/**
 * Where the token comes from, and what happens when it comes from nowhere.
 *
 * The precedence is the interesting part: it has to match what the CLI will do, or two processes reading
 * the same machine will disagree about which account is in force — and the symptom of that is a publish
 * landing on somebody else's site, which no error message would explain.
 */

/** Reads nothing, standing in for a machine with no config file. */
const noFile = () => {
	throw new Error("ENOENT");
};

describe("loadCredentials", () => {
	it("finds nothing when there is neither a variable nor a file", () => {
		expect(loadCredentials({}, noFile)).toBeNull();
	});

	it("takes the token from the environment", () => {
		expect(loadCredentials({ [TOKEN_VARIABLE]: "d2r_env" }, noFile)?.token).toBe("d2r_env");
	});

	it("takes the token from the file when the environment has none", () => {
		const read = () => JSON.stringify({ token: "d2r_file" });

		expect(loadCredentials({}, read)?.token).toBe("d2r_file");
	});

	it("lets the environment win, so a wrapper can point one chat at another account", () => {
		const read = () => JSON.stringify({ token: "d2r_file" });

		expect(loadCredentials({ [TOKEN_VARIABLE]: "d2r_env" }, read)?.token).toBe("d2r_env");
	});

	it("trims a token, because a copied one arrives with a newline", () => {
		expect(loadCredentials({ [TOKEN_VARIABLE]: "  d2r_env\n" }, noFile)?.token).toBe("d2r_env");
	});

	it("treats a whitespace-only token as none at all", () => {
		expect(loadCredentials({ [TOKEN_VARIABLE]: "   " }, noFile)).toBeNull();
	});

	it("treats a malformed config file as no config", () => {
		// The file is hand-edited until the CLI exists, so a stray comma is the likeliest thing in it. It
		// must read as "not signed in" rather than crashing the server at startup.
		const read = () => "{ not json";

		expect(loadCredentials({}, read)).toBeNull();
	});

	it("defaults the API to production", () => {
		expect(loadCredentials({ [TOKEN_VARIABLE]: "d2r_x" }, noFile)?.apiBaseUrl).toBe(
			DEFAULT_API_BASE_URL,
		);
	});

	it("lets the file point somewhere else, for a local stack", () => {
		const read = () => JSON.stringify({ token: "d2r_x", apiBaseUrl: "http://localhost:8001/api" });

		expect(loadCredentials({}, read)?.apiBaseUrl).toBe("http://localhost:8001/api");
	});
});

describe("missingCredentialsMessage", () => {
	it("names both ways to fix it and where a token comes from", () => {
		const message = missingCredentialsMessage();

		expect(message).toContain("https://dropto.run/account/tokens");
		expect(message).toContain(TOKEN_VARIABLE);
		expect(message).toContain("config.json");
	});

	it("warns that the token is shown once, since that is what makes a lost one unrecoverable", () => {
		expect(missingCredentialsMessage()).toContain("shown once");
	});

	it("tells the command line to run the command, and the server to call the tool", () => {
		// One message for both surfaces is what broke: it named `drop2run login`, which does not exist on
		// a machine that installed only the MCP server. Each surface has to name a step it can take.
		expect(missingCredentialsMessage("cli")).toContain("drop2run login");
		expect(missingCredentialsMessage("mcp")).toContain("`login` tool");
		expect(missingCredentialsMessage("mcp")).not.toContain("drop2run login");
	});

	it("tells the server which way of setting a token by hand needs a restart", () => {
		// The file is read on every call and the environment is read once at startup. A message that
		// offered them as equals would send somebody to the one that silently does nothing.
		const message = missingCredentialsMessage("mcp");

		expect(message).toContain("needs no restart");
		expect(message).toContain("restart this server");
	});
});
