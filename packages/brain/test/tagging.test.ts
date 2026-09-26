import { test } from "node:test";
import { expect } from "expect";
import { deriveStructuralTags } from "../src/tagging.js";

test("source_type x contributes x + social, sorted, no domain tag for x.com", () => {
  const tags = deriveStructuralTags({
    existingTags: [],
    sourceType: "x",
    sourceUri: "https://x.com/user/status/123",
    collectionSlugs: [],
  });
  expect(tags).toEqual(["social", "x"]);
});

test("source_type url contributes no source_type tag", () => {
  const tags = deriveStructuralTags({
    existingTags: [],
    sourceType: "url",
    sourceUri: "https://example.com/post",
    collectionSlugs: [],
  });
  expect(tags).toEqual([]);
});

test("github.com domain (exact host) maps to github + code, sorted", () => {
  const tags = deriveStructuralTags({
    existingTags: [],
    sourceType: "url",
    sourceUri: "https://github.com/foo/bar",
    collectionSlugs: [],
  });
  expect(tags).toEqual(["code", "github"]);
});

test("gist.github.com is its own exact-host mapping to github + code", () => {
  const tags = deriveStructuralTags({
    existingTags: [],
    sourceType: "url",
    sourceUri: "https://gist.github.com/foo/bar",
    collectionSlugs: [],
  });
  expect(tags).toEqual(["code", "github"]);
});

test("www. and m. host prefixes are stripped before domain lookup", () => {
  const www = deriveStructuralTags({
    existingTags: [],
    sourceType: "url",
    sourceUri: "https://www.github.com/foo",
    collectionSlugs: [],
  });
  expect(www).toEqual(["code", "github"]);

  const mobile = deriveStructuralTags({
    existingTags: [],
    sourceType: "url",
    sourceUri: "https://m.youtube.com/watch?v=abc",
    collectionSlugs: [],
  });
  expect(mobile).toEqual(["video", "youtube"]);
});

test("youtube.com maps to youtube + video, sorted", () => {
  const tags = deriveStructuralTags({
    existingTags: [],
    sourceType: "url",
    sourceUri: "https://youtube.com/watch?v=abc",
    collectionSlugs: [],
  });
  expect(tags).toEqual(["video", "youtube"]);
});

test("reddit.com maps to reddit + social, sorted", () => {
  const tags = deriveStructuralTags({
    existingTags: [],
    sourceType: "url",
    sourceUri: "https://reddit.com/r/foo",
    collectionSlugs: [],
  });
  expect(tags).toEqual(["reddit", "social"]);
});

test("unmapped domain contributes no domain tag", () => {
  const tags = deriveStructuralTags({
    existingTags: [],
    sourceType: "url",
    sourceUri: "https://example.com/post",
    collectionSlugs: [],
  });
  expect(tags).toEqual([]);
});

test("malformed non-URL source_uri resolves no domain tag (domainFromUri returns null)", () => {
  const tags = deriveStructuralTags({
    existingTags: ["legacy-recovery"],
    sourceType: "url",
    sourceUri: "not a url",
    collectionSlugs: [],
  });
  expect(tags).toEqual(["legacy-recovery"]);
});

test("collection membership slugs become tags, sorted", () => {
  const tags = deriveStructuralTags({
    existingTags: [],
    sourceType: "url",
    sourceUri: "https://example.com/post",
    collectionSlugs: ["legacy-links", "alpha-collection"],
  });
  expect(tags).toEqual(["alpha-collection", "legacy-links"]);
});

test("a document with only legacy-recovery and no structural matches is preserved as-is", () => {
  const tags = deriveStructuralTags({
    existingTags: ["legacy-recovery"],
    sourceType: "text",
    sourceUri: "text:legacy",
    collectionSlugs: [],
  });
  expect(tags).toEqual(["legacy-recovery"]);
});

test("existing tags are preserved first in stored order, structural tags grouped after", () => {
  const tags = deriveStructuralTags({
    existingTags: ["legacy-recovery", "my-custom-tag"],
    sourceType: "x",
    sourceUri: "https://x.com/user/status/123",
    collectionSlugs: ["legacy-links"],
  });
  expect(tags).toEqual([
    "legacy-recovery",
    "my-custom-tag",
    "social",
    "x",
    "legacy-links",
  ]);
});

test("overlapping tags dedup, keeping the existing tag's earlier position", () => {
  const tags = deriveStructuralTags({
    existingTags: ["code"],
    sourceType: "url",
    sourceUri: "https://github.com/foo/bar",
    collectionSlugs: [],
  });
  expect(tags).toEqual(["code", "github"]);
});

test("a collection slug containing a dot is skipped rather than reaching the FTS column", () => {
  const tags = deriveStructuralTags({
    existingTags: [],
    sourceType: "url",
    sourceUri: "https://example.com/post",
    collectionSlugs: ["release-1.0", "clean-slug"],
  });
  expect(tags).toEqual(["clean-slug"]);
});

test("derivation is deterministic: re-deriving the same inputs is byte-identical", () => {
  const input = {
    existingTags: ["legacy-recovery"],
    sourceType: "x",
    sourceUri: "https://x.com/user/status/123",
    collectionSlugs: ["legacy-links"],
  };
  const first = deriveStructuralTags(input);
  const second = deriveStructuralTags(input);
  expect(second).toEqual(first);
});
