const X_STATUS_PATH_RE = /^\/(?:i|[A-Za-z0-9_]{1,20})\/status\/(\d+)(?:\/|$)/i;
const X_ARTICLE_PATH_RE =
  /^\/(?:i\/article|[A-Za-z0-9_]{1,20}\/articles?)\/(\d+)(?:\/|$)/i;

export type CanonicalSourceType = "tweet" | "tweet_article" | "scraped_url";

export function validateHttpUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(String(input || "").trim());
  } catch {
    throw new Error("url must be an http(s) URL with a hostname");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname
  ) {
    throw new Error("url must be an http(s) URL with a hostname");
  }
  if (url.username || url.password) {
    throw new Error("credentialed URLs are not supported");
  }
  return url;
}

export function normalizedWebUrl(input: string): string {
  const url = validateHttpUrl(input);
  url.hash = "";
  url.username = "";
  url.password = "";
  if (
    (url.protocol === "http:" && url.port === "80") ||
    (url.protocol === "https:" && url.port === "443")
  ) {
    url.port = "";
  }
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname.length === 0) url.pathname = "/";
  return url.toString();
}

export function isXHost(input: string): boolean {
  try {
    const host = validateHttpUrl(input).hostname.toLowerCase();
    return ["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(
      host,
    );
  } catch {
    return false;
  }
}

export function xStatusId(input: string): string | null {
  if (!isXHost(input)) return null;
  return validateHttpUrl(input).pathname.match(X_STATUS_PATH_RE)?.[1] ?? null;
}

export function xArticleId(input: string): string | null {
  if (!isXHost(input)) return null;
  return validateHttpUrl(input).pathname.match(X_ARTICLE_PATH_RE)?.[1] ?? null;
}

export function canonicalizeSource(
  input: string,
): [CanonicalSourceType, string] {
  const normalized = normalizedWebUrl(input);
  const statusId = xStatusId(normalized);
  if (statusId) return ["tweet", `https://x.com/i/status/${statusId}`];
  const articleId = xArticleId(normalized);
  if (articleId)
    return ["tweet_article", `https://x.com/i/article/${articleId}`];
  return ["scraped_url", normalized];
}

export function sourceTypeForUrl(url: string): "url" | "url_pdf" {
  return validateHttpUrl(url).pathname.toLowerCase().endsWith(".pdf")
    ? "url_pdf"
    : "url";
}
