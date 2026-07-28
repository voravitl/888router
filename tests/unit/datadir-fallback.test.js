import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDataDir } from "@/lib/dataDir.js";

describe("getDataDir fallback behavior", () => {
  const origEnv = process.env.DATA_DIR;

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.DATA_DIR = origEnv;
    } else {
      delete process.env.DATA_DIR;
    }
    vi.restoreAllMocks();
  });

  it("returns default directory when DATA_DIR is not set", () => {
    delete process.env.DATA_DIR;
    const dir = getDataDir();
    expect(dir).toBe(path.join(os.homedir(), ".9router"));
  });

  it("falls back to default dir on ENOENT error", () => {
    process.env.DATA_DIR = "/invalid_nonexistent_root_path/data";
    const err = new Error("ENOENT");
    err.code = "ENOENT";
    vi.spyOn(fs, "mkdirSync").mockImplementationOnce(() => {
      throw err;
    });

    const dir = getDataDir();
    expect(dir).toBe(path.join(os.homedir(), ".9router"));
  });

  it("re-throws fatal system errors like ENOSPC", () => {
    process.env.DATA_DIR = "/some/path";
    const err = new Error("ENOSPC: no space left on device");
    err.code = "ENOSPC";
    vi.spyOn(fs, "mkdirSync").mockImplementationOnce(() => {
      throw err;
    });

    expect(() => getDataDir()).toThrow("ENOSPC");
  });
});
