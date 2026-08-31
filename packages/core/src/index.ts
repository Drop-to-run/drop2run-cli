/**
 * Public surface of the deploy engine.
 *
 * Everything here runs anywhere `fetch` and `crypto.subtle` do, which since Node 18 means a CLI as
 * well as a browser. What is deliberately absent is any way to obtain files: see {@link DeploySource}.
 * The browser's collector and its Web Worker entry stay in `apps/web`, because both are the browser.
 */

export {
	CLAIM_TOKEN_HEADER,
	type CompleteResponse,
	completeDeploy,
	type PrepareResponse,
	prepareDeploy,
} from "./api";
export { hashAll, sha256Hex } from "./hash";
export {
	checkLimits,
	formatBytes,
	isDocumentPath,
	MOBILE_WARNING_BYTES,
	type PlanLimits,
	shouldWarnAboutSize,
	totalBytes,
} from "./limits";
export { type DeployOptions, type DeploySource, deploy } from "./pipeline";
export {
	type ArchiveSummary,
	type DropSummary,
	type FolderSummary,
	type SummaryEntry,
	summarise,
} from "./summary";
export { MAX_NAME_LENGTH, suggestSiteName } from "./title";
export {
	ClientErrorCode,
	type CollectedFile,
	DeployError,
	type DroppedFile,
	type ManifestFile,
	type ProgressEvent,
	type ProgressListener,
} from "./types";
export {
	asDeployError,
	cancelled,
	isAbort,
	type UploadTarget,
	uploadAll,
} from "./upload";
