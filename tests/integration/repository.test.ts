import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";

test("README begins with the canonical fleet line byte-for-byte", async () => {
  const readme = await readFile(
    resolve(import.meta.dirname, "../../README.md"),
    "utf8",
  );
  expect(readme.split("\n", 1)[0]).toBe(
    "> *Slop Made With Sweat: Made with a lot of love by someone who loves code but read none of it.*",
  );
});

test("GitHub Actions use full commit pins and least default permissions", async () => {
  const workflow = await readFile(
    resolve(import.meta.dirname, "../../.github/workflows/native-linux.yml"),
    "utf8",
  );
  const uses = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map(
    (match) => match[1]!,
  );
  expect(uses.length).toBeGreaterThan(0);
  expect(uses.every((value) => /@[a-f0-9]{40}$/.test(value))).toBe(true);
  expect(workflow).toContain("permissions:\n  contents: read");
  expect(workflow).not.toMatch(/pull_request_target/);
  expect(
    workflow.match(/scripts\/vendor\/build-fx\.sh "\$fx_source"/g),
  ).toHaveLength(2);
  expect(workflow).toContain(
    'cmp "$RUNNER_TEMP/fx-first" vendor/payloads/linux-x64/fx/bin/fx',
  );
});

test("release identity and Linux Fx bytes are pinned for 0.1.1", async () => {
  const repository = resolve(import.meta.dirname, "../..");
  const rootPackage = JSON.parse(
    await readFile(resolve(repository, "package.json"), "utf8"),
  ) as { version: string };
  const manifest = JSON.parse(
    await readFile(resolve(repository, "vendor/manifest.json"), "utf8"),
  ) as {
    components: {
      fx: {
        sha256: string;
        build: {
          expectedReleaseBuildHost: string;
          candidateReleaseSha256: string;
          buildObservations: Array<{
            host: string;
            workflowRunId?: string;
            buildCount: number;
            sha256: string;
            role: string;
          }>;
          qualificationStatus: string;
        };
      };
    };
  };
  expect(rootPackage.version).toBe("0.1.1");
  const packageFiles = execFileSync(
    "git",
    [
      "ls-files",
      "-z",
      "package.json",
      "apps/*/package.json",
      "packages/*/package.json",
    ],
    {
      cwd: repository,
      encoding: "utf8",
    },
  )
    .split("\0")
    .filter(Boolean);
  for (const packageFile of packageFiles) {
    const packageData = JSON.parse(
      await readFile(resolve(repository, packageFile), "utf8"),
    ) as { version: string };
    expect(packageData.version, packageFile).toBe("0.1.1");
  }
  expect(await readFile(resolve(repository, "README.md"), "utf8")).toContain(
    "agentstack_0.1.1_amd64.deb",
  );
  expect(manifest.components.fx).toMatchObject({
    sha256: "ce9837da78ff43181c7e180626d39582ea715cb246f1ba29dad68588308bd1ba",
    build: {
      expectedReleaseBuildHost: "linux-x86_64",
      candidateReleaseSha256:
        "ce9837da78ff43181c7e180626d39582ea715cb246f1ba29dad68588308bd1ba",
      buildObservations: [
        {
          host: "linux-x86_64",
          workflowRunId: "35537630615",
          buildCount: 1,
          sha256:
            "ce9837da78ff43181c7e180626d39582ea715cb246f1ba29dad68588308bd1ba",
          role: "release-candidate",
        },
        {
          host: "darwin-arm64",
          buildCount: 2,
          sha256:
            "3926591e083eed79330c8de74031c4a4679ea60ee1421e09128b35420f120e09",
          role: "development-observation",
        },
      ],
      qualificationStatus: "pending-repeated-isolated-linux-builds",
    },
  });
  expect(manifest.components.fx.build).not.toHaveProperty(
    ["qualified", "Build", "Host"].join(""),
  );
  expect(manifest.components.fx.build).not.toHaveProperty(
    ["qualified", "Sha256"].join(""),
  );
  for (const script of [
    "scripts/vendor/build-fx.sh",
    "scripts/vendor/verify.sh",
  ]) {
    const text = await readFile(resolve(repository, script), "utf8");
    expect(text, script).toContain(
      "ce9837da78ff43181c7e180626d39582ea715cb246f1ba29dad68588308bd1ba",
    );
    expect(text, script).toContain(
      "3926591e083eed79330c8de74031c4a4679ea60ee1421e09128b35420f120e09",
    );
  }
});

test("tracked product files exclude removed product concepts", async () => {
  const repository = resolve(import.meta.dirname, "../..");
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: repository,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .filter((path) => !path.startsWith("vendor/licenses/"));
  const forbidden = [
    new RegExp(["agent", "lab"].join(""), "i"),
    /\bai[\s_-]+sdk\b/i,
    /\bai[\s_-]+elements?\b/i,
    new RegExp(["har", "ness"].join(""), "i"),
    new RegExp(["sand", "box"].join(""), "i"),
    new RegExp(["compatibility", "layer"].join("[\\s_-]+"), "i"),
  ];
  const findings: string[] = [];
  for (const path of tracked) {
    const text = await readFile(resolve(repository, path), "utf8");
    for (const pattern of forbidden) {
      const match = pattern.exec(text);
      if (match) findings.push(`${path}: ${match[0]}`);
    }
  }
  expect(findings).toEqual([]);
  expect(tracked).toContain("packages/engine-codex/package.json");
  expect(tracked).toContain("packages/engine-fx/package.json");
});
