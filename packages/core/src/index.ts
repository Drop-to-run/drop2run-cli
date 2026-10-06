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
	nestedIndexOf,
	type PlanLimits,
	predictedModeOf,
	renameOfLoneHtmlPage,
	type ServingMode,
	type SizedFile,
	servingModeOf,
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
	type SummaryFile,
	summarise,
	summariseFiles,
} from "./summary.js";
export { MAX_NAME_LENGTH, readSiteName, suggestSiteName } from "./title.js";
export {
	bytesOf,
	ClientErrorCode,
	type CollectedFile,
	DeployError,
	type DroppedFile,
	describeError,
	type FileContent,
	type ManifestFile,
	sizeOf,
	type ProgressEvent,
	type ProgressListener,
} from "./types.js";
export {
	asDeployError,
	cancelled,
	isAbort,
	outOfMemory,
	type PutRequest,
	type PutTransport,
	type RetryListener,
	StalledError,
	type UploadTarget,
	uploadAll,
	xhrTransport,
} from "./upload.js";
