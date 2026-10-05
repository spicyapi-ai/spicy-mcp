import path from "node:path";

/* Which content types `spicyapi_upload_file` may declare, and how a file extension maps onto them.
   Like upload-paths.ts, this is an implementation detail of that tool and is not exported from the
   package entry point.

   The list must cover the contract's `UploadURLRequest.contentType` enum value for value, and lives
   here rather than in the SDK on purpose: the published SDK's `UploadContentType` and its extension
   table still stop at eight media types, while the service has accepted reference documents (for
   fields such as `reference_file_url`) since 2026-09-29. The SDK forwards whatever content type it
   is given at runtime, so naming the type on this side is enough; once the SDK lists documents too,
   the two simply overlap. */

export const UPLOAD_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/wav",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.apple.keynote",
  "application/vnd.apple.pages",
  "application/vnd.apple.numbers",
  "text/plain",
  "text/markdown",
] as const;

export type McpUploadContentType = (typeof UPLOAD_CONTENT_TYPES)[number];

const CONTENT_TYPES_BY_EXTENSION: Readonly<Record<string, McpUploadContentType>> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".key": "application/vnd.apple.keynote",
  ".pages": "application/vnd.apple.pages",
  ".numbers": "application/vnd.apple.numbers",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
};

/** Every extension the tool recognises, without the dot, in table order. */
export const UPLOAD_EXTENSIONS: readonly string[] = Object.keys(CONTENT_TYPES_BY_EXTENSION).map(
  (extension) => extension.slice(1),
);

/**
 * The content type for a file, taken from its extension (case-insensitive).
 *
 * The error names every extension in the table, so it can never list fewer types than the tool
 * accepts - the SDK's own message would mention only its eight media types and leave the model
 * believing documents cannot be uploaded at all.
 */
export function inferUploadContentType(filePath: string): McpUploadContentType {
  const contentType = CONTENT_TYPES_BY_EXTENSION[path.extname(filePath).toLowerCase()];
  if (!contentType) {
    throw new TypeError(
      `cannot tell the file type from its extension; pass contentType, or use a file ending in one of: ${UPLOAD_EXTENSIONS.join(", ")}`,
    );
  }
  return contentType;
}
