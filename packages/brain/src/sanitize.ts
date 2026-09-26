const ERROR_LIMIT = 600;
const COMMON_PRIVATE_PATH =
  /(^|[\s"'(=])((?:\/(?:Users|home|tmp|private|var\/folders)\/)[^\s"',;)]+)/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Remove private filesystem locations while retaining a useful error class. */
function sanitizePrivatePaths(
  value: unknown,
  privatePaths: readonly string[] = [],
): string {
  let message = value instanceof Error ? value.message : String(value ?? "");
  for (const path of [...privatePaths].sort((a, b) => b.length - a.length)) {
    if (!path) continue;
    message = message.replace(
      new RegExp(escapeRegExp(path), "g"),
      "[PRIVATE_PATH]",
    );
  }
  return message.replace(COMMON_PRIVATE_PATH, "$1[PRIVATE_PATH]");
}

/** Sanitize an Artifact/filesystem diagnostic without disclosing private roots. */
export function sanitizeArtifactError(
  value: unknown,
  privatePaths: readonly string[] = [],
): string {
  return sanitizeExternalError(sanitizePrivatePaths(value, privatePaths));
}

/** Redact likely credentials and private paths before an error is persisted or emitted. */
export function sanitizeExternalError(value: unknown): string {
  let message = sanitizePrivatePaths(value);
  message = Array.from(message, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127 ? " " : character;
  }).join("");
  message = message
    .replace(
      /\b((?:set-cookie|cookie|proxy-authorization|authorization)\s*[:=]\s*)[^\r\n]*/gi,
      "$1[REDACTED]",
    )
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(
      /([?&](?:access_token|api[_-]?key|auth|authorization|credential|password|passwd|secret|token)=)[^&#\s]*/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(["']?[a-z0-9_-]*(?:api[_-]?key|authorization|credential|password|passwd|secret|token)[a-z0-9_-]*["']?\s*[:=]\s*["']?)[^\s,"';&}]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g,
      "[REDACTED]",
    )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!message) message = "external command failed";
  if (message.length > ERROR_LIMIT) {
    message = `${message.slice(0, ERROR_LIMIT)}…`;
  }
  return message;
}
