import { createHash } from "node:crypto";
import { DEFAULT_MAX_BYTES } from "./extract.js";
import type {
  ExtractionFanoutPlan,
  ExtractionRelation,
  FanoutDiscovery,
  FanoutSuppressionReason,
  ResourceRelationType,
} from "./types.js";
import {
  isXHost,
  normalizedWebUrl,
  validateHttpUrl,
  xArticleId,
  xStatusId,
} from "./url.js";

export const LINKED_FAN_OUT_LIMIT = 25;
export const QUEUED_FANOUT_JOB_PREFIX = "x-fanout:v1:";

const MEDIA_PATH_RE =
  /\.(?:avif|bmp|gif|jpe?g|m4a|m4v|mov|mp3|mp4|ogg|png|svg|webm|webp|wav)$/i;
const X_MEDIA_HOSTS = new Set([
  "abs.twimg.com",
  "pbs.twimg.com",
  "ton.twitter.com",
  "video.twimg.com",
]);
const MEDIA_FORMATS = new Set([
  "avif",
  "gif",
  "jpeg",
  "jpg",
  "mp4",
  "png",
  "webm",
  "webp",
]);

function relationIdentity(url: string): {
  canonicalUrl: string;
  resourceKey: { type: string; value: string };
  relationType: ResourceRelationType;
} {
  const statusId = xStatusId(url);
  if (statusId !== null) {
    return {
      canonicalUrl: `https://x.com/i/status/${statusId}`,
      resourceKey: { type: "x:status", value: statusId },
      relationType: "quoted_post",
    };
  }
  const articleId = xArticleId(url);
  if (articleId !== null) {
    return {
      canonicalUrl: `https://x.com/i/article/${articleId}`,
      resourceKey: { type: "x:article", value: articleId },
      relationType: "article",
    };
  }
  const canonicalUrl = normalizedWebUrl(url);
  return {
    canonicalUrl,
    resourceKey: { type: "url", value: canonicalUrl },
    relationType: "content_link",
  };
}

function mappedRelationType(
  extractionType: ExtractionRelation["relation_type"],
  inferredType: ResourceRelationType,
): ResourceRelationType {
  if (extractionType !== "references") return extractionType;
  return inferredType === "quoted_post" ? "content_link" : inferredType;
}

function resourceIdentityKey(resourceKey: {
  type: string;
  value: string;
}): string {
  return `${resourceKey.type}\u0000${resourceKey.value}`;
}

function childIntent(url: string): string {
  return JSON.stringify({
    version: 1,
    kind: "url",
    ingress: "x-fanout",
    collections: [],
    payload: { url: { url } },
    options: {
      tags: [],
      force: false,
      max_bytes: DEFAULT_MAX_BYTES,
    },
  });
}

function childIdempotencyKey(resourceKey: {
  type: string;
  value: string;
}): string {
  const digest = createHash("sha256")
    .update(resourceIdentityKey(resourceKey))
    .digest("hex");
  return `${QUEUED_FANOUT_JOB_PREFIX}${digest}`;
}

function unsafeDestination(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    const [first = 0, second = 0] = host.split(".").map(Number);
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    );
  }
  if (host.includes(":")) {
    return (
      host === "::" ||
      host === "::1" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      /^fe[89ab]/.test(host) ||
      host.startsWith("ff") ||
      host.startsWith("::ffff:")
    );
  }
  return false;
}

function policySuppression(
  targetUrl: string,
  relationType: ResourceRelationType,
): FanoutSuppressionReason | null {
  const parsed = validateHttpUrl(targetUrl);
  if (unsafeDestination(parsed.hostname)) return "unsafe_destination";
  if (
    (relationType === "article" && xArticleId(targetUrl) === null) ||
    (relationType === "quoted_post" && xStatusId(targetUrl) === null)
  ) {
    return "relation_target_mismatch";
  }
  if (
    isXHost(targetUrl) &&
    xStatusId(targetUrl) === null &&
    xArticleId(targetUrl) === null
  ) {
    return "excluded_x_chrome";
  }
  if (
    X_MEDIA_HOSTS.has(parsed.hostname.toLowerCase()) ||
    MEDIA_PATH_RE.test(parsed.pathname) ||
    MEDIA_FORMATS.has((parsed.searchParams.get("format") ?? "").toLowerCase())
  ) {
    return "excluded_media";
  }
  return null;
}

export function planQueuedUrlFanout(
  sourceUrl: string,
  relations: readonly ExtractionRelation[],
  options: { oneHopChild?: boolean } = {},
): ExtractionFanoutPlan {
  const rootEligible =
    xStatusId(sourceUrl) !== null || xArticleId(sourceUrl) !== null;
  const parent = relationIdentity(sourceUrl);
  const parentKey = resourceIdentityKey(parent.resourceKey);
  const seen = new Set<string>();
  let admitted = 0;
  const discoveries: FanoutDiscovery[] = relations.map((relation, index) => {
    const target = relationIdentity(relation.target_url);
    const targetKey = resourceIdentityKey(target.resourceKey);
    const relationType = mappedRelationType(
      relation.relation_type,
      target.relationType,
    );
    let suppressionReason = policySuppression(
      relation.target_url,
      relationType,
    );
    if (suppressionReason === null) {
      if (options.oneHopChild === true) suppressionReason = "one_hop_limit";
      else if (!rootEligible) suppressionReason = "ineligible_root";
    }
    if (targetKey === parentKey) suppressionReason = "self_reference";
    else if (seen.has(targetKey)) suppressionReason = "duplicate_destination";
    else {
      seen.add(targetKey);
      if (suppressionReason === null) {
        if (admitted >= LINKED_FAN_OUT_LIMIT) {
          suppressionReason = "fanout_limit";
        } else {
          admitted += 1;
        }
      }
    }
    return {
      ordinal: index,
      relationType,
      targetUrl: relation.target_url,
      canonicalUrl: target.canonicalUrl,
      resourceKey: target.resourceKey,
      childIdempotencyKey: childIdempotencyKey(target.resourceKey),
      childIntent: childIntent(target.canonicalUrl),
      suppressionReason,
    };
  });
  return { discoveries };
}
