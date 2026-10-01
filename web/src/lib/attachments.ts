/**
 * Client-side attachment validation: which files can be attached.
 *
 * This mirrors the authoritative server-side type check in
 * omnigent/runtime/content_resolver.py (`attachment_type_allowed`) and the
 * upload route (415 for unsupported types). Keeping a copy here lets us
 * reject a bad file at paste/drop/pick time, before a slow upload, with a
 * friendly message. The server still enforces; this is UX only.
 *
 * There is deliberately NO size limit, client or server (Calvin, 2026-09-08:
 * "remove it so i can upload whatever i want"). Two external ceilings still
 * apply and surface at send time, not here: the model provider's per-request
 * limit (attachments are inlined as base64), and Cloudflare's 100 MB request
 * body limit in front of the public hostname.
 */

export type AttachmentCategory = "image" | "pdf" | "archive" | "office" | "text";

const attachmentIds = new WeakMap<File, string>();
let nextAttachmentId = 0;

export function attachmentKey(file: File): string {
  const existing = attachmentIds.get(file);
  if (existing) return existing;
  const id = `attachment-${nextAttachmentId++}`;
  attachmentIds.set(file, id);
  return id;
}

// Text-bearing application/* MIME types (the rest of the text-like surface
// is text/*). Mirrors _TEXT_LIKE_APPLICATION_MIMES on the server.
const TEXT_LIKE_APPLICATION_MIMES = new Set([
  "application/json",
  "application/javascript",
  "application/jsonl",
  "application/x-ndjson",
  "application/x-ipynb+json",
]);

// Text/code extensions whose browser-reported MIME type is often empty or
// wrong (e.g. a .ts file reports video/mp2t, .rs reports nothing). Mirrors
// the code entries in _EXTRA_MIME_TYPES on the server so we accept the same
// files the backend resolves to a text/* type.
const TEXT_CODE_EXTENSIONS = new Set([
  ".txt",
  ".log",
  ".md",
  ".markdown",
  ".csv",
  ".json",
  ".jsonl",
  ".ndjson",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".env",
  ".lock",
  ".proto",
  ".graphql",
  ".gql",
  ".html",
  ".htm",
  ".xml",
  ".css",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".scala",
  ".swift",
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".hpp",
  ".cs",
  ".php",
  ".pl",
  ".r",
  ".jl",
  ".lua",
  ".ex",
  ".exs",
  ".erl",
  ".hs",
  ".clj",
  ".dart",
  ".vue",
  ".svelte",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".sql",
  ".tf",
  ".hcl",
  ".gradle",
  ".dockerfile",
  ".ipynb",
]);

// Office / OpenDocument / RTF extensions whose browser-reported MIME is often
// empty. Mirrors the Office MIME handling in content_resolver.py.
const OFFICE_EXTENSIONS = new Set([
  ".doc", ".docx", ".docm", ".dot", ".dotx",
  ".xls", ".xlsx", ".xlsm", ".xlsb", ".xlt", ".xltx",
  ".ppt", ".pptx", ".pptm", ".pps", ".ppsx", ".pot", ".potx",
  ".odt", ".ods", ".odp", ".rtf",
]);

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

/**
 * Classify a file into an attachment category, or `null` if its type is not
 * supported (e.g. pptx, docx, xlsx, zip, binaries). Uses the browser MIME
 * type first, falling back to the filename extension for code/text files
 * whose MIME is unreliable.
 */
export function classifyAttachment(file: File): AttachmentCategory | null {
  const type = file.type || "";
  const ext = extensionOf(file.name || "");

  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf" || ext === ".pdf") return "pdf";
  if (
    type === "application/zip" ||
    type === "application/x-zip-compressed" ||
    ext === ".zip"
  ) {
    return "archive";
  }
  // A text/code extension wins over an Office-looking MIME: Windows tags
  // .csv as application/vnd.ms-excel and it must stay a text attachment.
  if (
    !TEXT_CODE_EXTENSIONS.has(ext) &&
    (type.startsWith("application/vnd.openxmlformats-officedocument.") ||
      type.startsWith("application/vnd.ms-") ||
      type.startsWith("application/vnd.oasis.opendocument.") ||
      type === "application/msword" ||
      type === "application/rtf" ||
      OFFICE_EXTENSIONS.has(ext))
  ) {
    return "office";
  }
  if (
    type.startsWith("text/") ||
    TEXT_LIKE_APPLICATION_MIMES.has(type) ||
    TEXT_CODE_EXTENSIONS.has(ext)
  ) {
    return "text";
  }
  return null;
}

export interface AttachmentValidation {
  /** Files that passed type + size checks. */
  accepted: File[];
  /** Human-readable rejection messages, one per rejected file. */
  errors: string[];
}

/**
 * Split *files* into accepted attachments and rejection messages. A file is
 * rejected only when its type is unsupported; there is no size check.
 */
export function validateAttachments(files: File[]): AttachmentValidation {
  const accepted: File[] = [];
  const errors: string[] = [];

  for (const file of files) {
    const name = file.name || "file";
    const category = classifyAttachment(file);
    if (category === null) {
      errors.push(
        `"${name}" can't be attached — only images, PDF, ZIP, Office, and text/code files are supported.`,
      );
      continue;
    }
    accepted.push(file);
  }

  return { accepted, errors };
}
