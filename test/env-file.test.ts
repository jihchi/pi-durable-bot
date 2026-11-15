import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readSecrets } from "../src/core/env-file.ts";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pots-env-file-"));
  file = join(dir, "test.env");
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

it("reads only requested required and optional keys without exporting or evaluating them", () => {
  vi.stubEnv("POTS_TEST_SECRET", "process-value");
  vi.stubEnv("POTS_TEST_OPTIONAL", undefined);
  writeFileSync(file, "POTS_TEST_SECRET='$(never-run-this)'\nexport POTS_TEST_OPTIONAL=111,222\nUNREQUESTED=private\n");
  expect(readSecrets(file, ["POTS_TEST_SECRET"], ["POTS_TEST_OPTIONAL"])).toEqual({ POTS_TEST_SECRET: "$(never-run-this)", POTS_TEST_OPTIONAL: "111,222" });
  expect(process.env.POTS_TEST_SECRET).toBe("process-value");
  expect(process.env.POTS_TEST_OPTIONAL).toBeUndefined();
});

it("distinguishes an absent optional key from an explicitly empty one", () => {
  writeFileSync(file, "REQUIRED=value\n");
  expect(readSecrets(file, ["REQUIRED"], ["OPTIONAL"])).toEqual({ REQUIRED: "value" });
  writeFileSync(file, "REQUIRED=value\nOPTIONAL=\n");
  expect(readSecrets(file, ["REQUIRED"], ["OPTIONAL"])).toEqual({ REQUIRED: "value", OPTIONAL: "" });
});

it("still requires nonempty mandatory keys and does not include values in its error", () => {
  writeFileSync(file, "REQUIRED=\nOPTIONAL=private\n");
  expect(() => readSecrets(file, ["REQUIRED"], ["OPTIONAL"])).toThrow(`${file}: missing REQUIRED`);
});
