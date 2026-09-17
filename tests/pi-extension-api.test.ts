import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createExtensionApiDouble } from "./fixtures/pi-extension-api.js";

describe("extension API double", () => {
  it("preserves callback argument types through capture and replay", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [
          "node_modules/typescript/bin/tsc",
          "--ignoreConfig",
          "--noEmit",
          "--strict",
          "--skipLibCheck",
          "--target",
          "es2022",
          "--module",
          "esnext",
          "--moduleResolution",
          "bundler",
          "tests/fixtures/pi-extension-api.typecheck.ts",
        ],
        { encoding: "utf8", stdio: "pipe" },
      ),
    ).not.toThrow();
  });

  it("fails loudly for an unused host member", () => {
    expect(() => createExtensionApiDouble().getFlag("unused")).toThrow(
      "createExtensionApiDouble: getFlag is not implemented",
    );
  });
});
