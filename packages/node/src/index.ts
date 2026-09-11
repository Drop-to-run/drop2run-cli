/**
 * The parts of Drop2Run that need a filesystem and a home directory.
 *
 * <b>Why this is a package and not part of `@drop2run/core`.</b> Core must stay importable in a browser
 * — it runs inside a Web Worker, and `apps/web/test/isolation.test.ts` fails the build if anything in it
 * reaches for something a browser does not have. Everything here imports `node:fs` or `node:os`.
 *
 * <b>And why it is not simply inside the CLI.</b> Two consumers need it: the CLI and the MCP server.
 * The first thing they would share is the list of files never to publish, and a second copy of that list
 * is how one surface ends up uploading a `.git` directory the other refuses — which already happened
 * once and is the reason `shouldIgnore` lives in core rather than beside a collector.
 *
 * This is a deviation from the brief's §3, which lists only `core`, `cli`, `mcp` and `action`. The
 * deviation is the discovery that "portable" and "not a browser" are different things.
 */

export {
	type AccessToken,
	createSite,
	deleteSite,
	findSite,
	listSites,
	listTokens,
	type PromotedDeploy,
	promoteDeploy,
	type SiteSummary,
} from "./api.js";
export {
	type CredentialSurface,
	type Credentials,
	clearToken,
	configPath,
	DEFAULT_API_BASE_URL,
	dashboardUrlFor,
	loadCredentials,
	missingCredentialsMessage,
	resolveApiBaseUrl,
	saveToken,
	TOKEN_VARIABLE,
} from "./config.js";
export {
	type Attempt,
	type Callback,
	clientName,
	consentUrl,
	type DevicePoll,
	type DeviceRequest,
	type ExchangedToken,
	exchange,
	type Listener,
	listen,
	newAttempt,
	openBrowser,
	pollDevice,
	startDevice,
	waitForCallback,
} from "./login.js";
export {
	PROJECT_FILE,
	type Project,
	projectPath,
	readProject,
	writeProject,
} from "./project.js";
export {
	type AuthoredFile,
	type PublishResult,
	publish,
	publishDirectory,
	publishFiles,
} from "./publish.js";
export { directorySource } from "./source.js";
