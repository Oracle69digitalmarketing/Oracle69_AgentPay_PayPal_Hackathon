import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("documented startup configuration", () => {
  it("loads .env with Node's native --env-file flag", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.scripts["start"]).toBe("node --env-file=.env dist/server/server.js");
    expect(pkg.dependencies?.["dotenv"]).toBeUndefined();
    expect(pkg.devDependencies?.["dotenv"]).toBeUndefined();
  });

  it("keeps .env ignored while preserving .env.example", () => {
    const ignore = readFileSync(join(ROOT, ".gitignore"), "utf8").split(/\r?\n/);
    expect(ignore).toContain(".env");
    expect(ignore).toContain(".env.*");
    expect(ignore).toContain("!.env.example");
    expect(readFileSync(join(ROOT, ".env.example"), "utf8")).toContain("PAYPAL_CLIENT_ID=<your-paypal-sandbox-client-id>");
  });

  it("proves Node 22 can load an env file without printing secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentpay-env-load-"));
    const file = join(dir, ".env");
    try {
      writeFileSync(file, "AGENTPAY_ENV_FILE_SENTINEL=loaded\n", { mode: 0o600 });
      const result = spawnSync(
        process.execPath,
        ["--env-file=" + file, "-e", "process.stdout.write(process.env.AGENTPAY_ENV_FILE_SENTINEL ?? 'missing')"],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("loaded");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
