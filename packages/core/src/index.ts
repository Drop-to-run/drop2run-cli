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
	DEFAULT_REQUEST_TIMEOUT_MS,
	type PrepareResponse,
	prepareDeploy,
} from "./api.js";
export {
	DOCUMENT_EXTENSIONS,
	EDITABLE_EXTENSIONS,
	extensionOf,
	FILE_TYPES,
	type FileKind,
	type FileType,
	GALLERY_EXTENSIONS,
	MEDIA_TYPES,
	READER_EXTENSIONS,
	VIEWABLE_EXTENSIONS,
	WEB_ASSET_EXTENSIONS,
} from "./fileTypes.js";
export { hashAll, sha256Hex } from "./hash.js";
export { shouldIgnore } from "./ignore.js";
export {
	archiveRefusal,
	canPublish,
	checkLimits,
	formatBytes,
	isDocumentPath,
	isImageFolder,
	isViewablePath,
	MOBILE_WARNING_BYTES,
	type PlanLimits,
	renameOfLoneHtmlPage,
	type SizedFile,
	shouldWarnAboutSize,
	sizeRefusal,
	totalBytes,
} from "./limits.js";
export { type DeployOptions, type DeploySource, deploy } from "./pipeline.js";
export {
	type ArchiveSummary,
	type DropSummary,
	type FolderSummary,
	type SummaryEntry,
	summarise,
} from "./summary.js";
export { MAX_NAME_LENGTH, suggestSiteName } from "./title.js";
export {
	ClientErrorCode,
	type CollectedFile,
	DeployError,
	type DroppedFile,
	describeError,
	type ManifestFile,
	type ProgressEvent,
	type ProgressListener,
} from "./types.js";
export {
	asDeployError,
	cancelled,
	isAbort,
	type UploadTarget,
	uploadAll,
} from "./upload.js";
