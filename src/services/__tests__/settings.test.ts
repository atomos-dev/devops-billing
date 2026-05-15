/**
 * Unit tests for the settings service (src/services/settings.ts).
 *
 * Covers:
 * - getProviderSetting: DB hit / miss
 * - getDecryptedCredentials: with credentials, without, decrypt failure
 * - getEffectiveCredentials: DB priority, env fallback, neither
 * - isProviderEnabled: DB row enabled/disabled, env paths, no config
 * - getAllProviderSettings: correct view construction with password field redaction
 * - upsertProviderSetting: insert new, update existing, credential merge, clear credentials
 * - updateTestResult: update existing row, auto-create row for registered provider
 *
 * Mocks:
 * - @/db            — chainable synchronous DB (select/update/insert)
 * - @/db/schema     — providerSettings table reference
 * - @/lib/crypto    — encrypt / decrypt
 * - drizzle-orm     — eq
 * - @/providers/registry — PROVIDER_REGISTRY with aws + digitalocean stubs
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock state — vi.hoisted executes before vi.mock factories
// ---------------------------------------------------------------------------

const { mockDb, mockEncrypt, mockDecrypt, _state } = vi.hoisted(() => {
  /**
   * Shared mutable state bucket.
   * Tests set these to control what the DB chain terminal methods return.
   */
  const _state = {
    /** What .get() returns on the select chain */
    selectGetReturn: undefined as unknown,
    /** What .get() returns after .returning() on the insert chain */
    insertReturningGetReturn: undefined as unknown,
    /** Chain instances — rebuilt in beforeEach */
    selectChain: null as ReturnType<typeof _createChain> | null,
    updateChain: null as ReturnType<typeof _createChain> | null,
    insertChain: null as ReturnType<typeof _createChain> | null,
  };

  /**
   * Build a proxy for a chainable synchronous Drizzle query builder.
   * Supported patterns:
   *   db.select().from(t).where(cond).get()
   *   db.update(t).set(d).where(cond).run()
   *   db.insert(t).values(d).returning().get()
   *   db.insert(t).values(d).run()
   */
  function _createChain() {
    const run = vi.fn();
    const get = vi.fn(() => _state.selectGetReturn);
    const returningGet = vi.fn(() => _state.insertReturningGetReturn);
    const returning = vi.fn(() => ({ get: returningGet }));

    const chain = {
      from: vi.fn(),
      where: vi.fn(),
      set: vi.fn(),
      values: vi.fn(),
      returning,
      get,
      run,
      _returningGet: returningGet, // expose for assertions
    } as Record<string, Mock> & { _returningGet: Mock };

    // Make intermediate methods self-chainable
    for (const key of ["from", "where", "set", "values"] as const) {
      chain[key].mockReturnValue(chain);
    }

    return chain;
  }

  const mockDb = {
    select: vi.fn(() => _state.selectChain),
    update: vi.fn(() => _state.updateChain),
    insert: vi.fn(() => _state.insertChain),
    _createChain,
  };

  const mockEncrypt = vi.fn((plaintext: string) => `encrypted(${plaintext})`);
  const mockDecrypt = vi.fn((ciphertext: string) => {
    // Default: strip the "encrypted(...)" wrapper added by mockEncrypt
    const m = /^encrypted\((.+)\)$/.exec(ciphertext);
    return m ? m[1] : ciphertext;
  });

  return { mockDb, mockEncrypt, mockDecrypt, _state };
});

// ---------------------------------------------------------------------------
// Module mocks (factories reference only hoisted values)
// ---------------------------------------------------------------------------

vi.mock("@/db", () => ({ db: mockDb }));

vi.mock("@/db/schema", () => ({
  providerSettings: {
    provider: "provider_col",
    id: "id_col",
    $inferSelect: {},
  },
}));

vi.mock("@/lib/crypto", () => ({
  encrypt: (...args: unknown[]) => mockEncrypt(args[0] as string),
  decrypt: (...args: unknown[]) => mockDecrypt(args[0] as string),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

vi.mock("@/providers/registry", () => ({
  PROVIDER_REGISTRY: {
    aws: {
      displayName: "Amazon Web Services",
      credentialFields: [
        { key: "accessKeyId", label: "Access Key ID", type: "text", required: true },
        { key: "secretAccessKey", label: "Secret Access Key", type: "password", required: true },
        { key: "region", label: "Default Region", type: "text", required: true, default: "us-east-1" },
        {
          key: "resourceRegions",
          label: "Resource Regions",
          type: "text",
          required: false,
          hint: "Comma-separated region codes",
        },
      ],
      toProviderConfig: (creds: Record<string, string>) => creds,
    },
    digitalocean: {
      displayName: "DigitalOcean",
      credentialFields: [
        { key: "apiToken", label: "API Token", type: "password", required: true },
      ],
      toProviderConfig: (creds: Record<string, string>) => creds,
    },
  },
}));

// ---------------------------------------------------------------------------
// Import subjects AFTER mocks are wired
// ---------------------------------------------------------------------------

import {
  getProviderSetting,
  getDecryptedCredentials,
  getEffectiveCredentials,
  isProviderEnabled,
  getAllProviderSettings,
  upsertProviderSetting,
  updateTestResult,
} from "../settings";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convenience: access current select chain */
function sel() {
  return _state.selectChain!;
}
/** Convenience: access current update chain */
function upd() {
  return _state.updateChain!;
}
/** Convenience: access current insert chain */
function ins() {
  return _state.insertChain!;
}

/** Build a minimal ProviderSettingRow stub */
function makeRow(overrides: Partial<{
  id: number;
  provider: string;
  displayName: string;
  enabled: boolean;
  credentials: string | null;
  lastTestedAt: string | null;
  lastTestResult: boolean | null;
  createdAt: string;
  updatedAt: string;
}> = {}) {
  return {
    id: 1,
    provider: "aws",
    displayName: "Amazon Web Services",
    enabled: true,
    credentials: null,
    lastTestedAt: null,
    lastTestResult: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Rebuild fresh chains so each test starts from a clean state
  _state.selectChain = mockDb._createChain();
  _state.updateChain = mockDb._createChain();
  _state.insertChain = mockDb._createChain();

  mockDb.select.mockImplementation(() => _state.selectChain);
  mockDb.update.mockImplementation(() => _state.updateChain);
  mockDb.insert.mockImplementation(() => _state.insertChain);

  // Reset DB terminal return values
  _state.selectGetReturn = undefined;
  _state.insertReturningGetReturn = undefined;
});

afterEach(() => {
  // Restore any process.env mutations made during the test
  delete process.env.AWS_ENABLED;
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_REGION;
  delete process.env.AWS_RESOURCE_REGIONS;
  delete process.env.DO_ENABLED;
  delete process.env.DO_API_TOKEN;
});

// ===========================================================================
// 1. getProviderSetting
// ===========================================================================

describe("getProviderSetting", () => {
  it("returns the DB row when found", () => {
    const row = makeRow();
    _state.selectGetReturn = row;

    const result = getProviderSetting("aws");

    expect(result).toEqual(row);
    expect(mockDb.select).toHaveBeenCalledTimes(1);
    expect(sel().from).toHaveBeenCalledTimes(1);
    expect(sel().where).toHaveBeenCalledTimes(1);
    expect(sel().get).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when no row exists", () => {
    _state.selectGetReturn = undefined;

    const result = getProviderSetting("aws");

    expect(result).toBeUndefined();
  });
});

// ===========================================================================
// 2. getDecryptedCredentials
// ===========================================================================

describe("getDecryptedCredentials", () => {
  it("returns the parsed credential object when credentials are stored", () => {
    const creds = { accessKeyId: "AKIA123", secretAccessKey: "secret" };
    const row = makeRow({ credentials: `encrypted(${JSON.stringify(creds)})` });
    _state.selectGetReturn = row;

    const result = getDecryptedCredentials("aws");

    expect(mockDecrypt).toHaveBeenCalledWith(row.credentials);
    expect(result).toEqual(creds);
  });

  it("returns null when the row has no credentials field", () => {
    _state.selectGetReturn = makeRow({ credentials: null });

    const result = getDecryptedCredentials("aws");

    expect(result).toBeNull();
    expect(mockDecrypt).not.toHaveBeenCalled();
  });

  it("returns null when no DB row exists for the provider", () => {
    _state.selectGetReturn = undefined;

    const result = getDecryptedCredentials("aws");

    expect(result).toBeNull();
  });

  it("returns null and logs an error when decrypt throws", () => {
    const row = makeRow({ credentials: "corrupted-ciphertext" });
    _state.selectGetReturn = row;
    mockDecrypt.mockImplementationOnce(() => {
      throw new Error("auth tag mismatch");
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = getDecryptedCredentials("aws");

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("aws"),
      expect.any(Error)
    );
    consoleSpy.mockRestore();
  });

  it("returns null when decrypt returns invalid JSON", () => {
    const row = makeRow({ credentials: "encrypted(not-json)" });
    _state.selectGetReturn = row;
    // mockDecrypt strips the wrapper — "not-json" is returned, JSON.parse throws
    mockDecrypt.mockReturnValueOnce("not valid json {{");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = getDecryptedCredentials("aws");

    expect(result).toBeNull();
    consoleSpy.mockRestore();
  });
});

// ===========================================================================
// 3. getEffectiveCredentials
// ===========================================================================

describe("getEffectiveCredentials", () => {
  it("returns DB credentials when a DB row with credentials exists (DB priority)", () => {
    const dbCreds = { accessKeyId: "DB_KEY", secretAccessKey: "DB_SECRET", region: "eu-west-1" };
    const row = makeRow({ credentials: `encrypted(${JSON.stringify(dbCreds)})` });
    _state.selectGetReturn = row;

    // Also set env vars — these should NOT be used
    process.env.AWS_ACCESS_KEY_ID = "ENV_KEY";
    process.env.AWS_SECRET_ACCESS_KEY = "ENV_SECRET";

    const result = getEffectiveCredentials("aws");

    expect(result).toEqual(dbCreds);
  });

  it("falls back to env credentials when no DB credentials stored", () => {
    // No DB row
    _state.selectGetReturn = undefined;

    process.env.AWS_ACCESS_KEY_ID = "ENV_KEY";
    process.env.AWS_SECRET_ACCESS_KEY = "ENV_SECRET";
    process.env.AWS_REGION = "ap-southeast-1";
    process.env.AWS_RESOURCE_REGIONS = "ap-southeast-1,us-east-1";

    const result = getEffectiveCredentials("aws");

    expect(result).toEqual({
      accessKeyId: "ENV_KEY",
      secretAccessKey: "ENV_SECRET",
      region: "ap-southeast-1",
      resourceRegions: "ap-southeast-1,us-east-1",
    });
  });

  it("falls back to env credentials for digitalocean", () => {
    _state.selectGetReturn = undefined;
    process.env.DO_API_TOKEN = "do-token-xyz";

    const result = getEffectiveCredentials("digitalocean");

    expect(result).toEqual({ apiToken: "do-token-xyz" });
  });

  it("returns null when neither DB credentials nor env credentials are available", () => {
    _state.selectGetReturn = undefined;
    // No env vars set

    const result = getEffectiveCredentials("aws");

    expect(result).toBeNull();
  });

  it("returns null for an unrecognised provider", () => {
    _state.selectGetReturn = undefined;

    const result = getEffectiveCredentials("unknown-provider");

    expect(result).toBeNull();
  });

  it("uses default region 'us-east-1' when AWS_REGION is not set", () => {
    _state.selectGetReturn = undefined;
    process.env.AWS_ACCESS_KEY_ID = "K";
    process.env.AWS_SECRET_ACCESS_KEY = "S";
    // AWS_REGION intentionally unset

    const result = getEffectiveCredentials("aws") as Record<string, string>;

    expect(result.region).toBe("us-east-1");
    expect(result.resourceRegions).toBe("us-east-1");
  });
});

// ===========================================================================
// 4. isProviderEnabled
// ===========================================================================

describe("isProviderEnabled", () => {
  it("returns true when a DB row exists and enabled = true", () => {
    _state.selectGetReturn = makeRow({ enabled: true });

    expect(isProviderEnabled("aws")).toBe(true);
  });

  it("returns false when a DB row exists and enabled = false", () => {
    _state.selectGetReturn = makeRow({ enabled: false });

    expect(isProviderEnabled("aws")).toBe(false);
  });

  it("does NOT fall back to env when a DB row exists (DB row is authoritative)", () => {
    _state.selectGetReturn = makeRow({ enabled: false });
    // Set env to enabled — should still be false because row.enabled = false
    process.env.AWS_ENABLED = "true";
    process.env.AWS_ACCESS_KEY_ID = "K";
    process.env.AWS_SECRET_ACCESS_KEY = "S";

    expect(isProviderEnabled("aws")).toBe(false);
  });

  it("returns true when no DB row and env is enabled (AWS_ENABLED not 'false') with credentials", () => {
    _state.selectGetReturn = undefined;
    process.env.AWS_ACCESS_KEY_ID = "K";
    process.env.AWS_SECRET_ACCESS_KEY = "S";
    // AWS_ENABLED not set → default enabled

    expect(isProviderEnabled("aws")).toBe(true);
  });

  it("returns false when no DB row and AWS_ENABLED='false'", () => {
    _state.selectGetReturn = undefined;
    process.env.AWS_ENABLED = "false";
    process.env.AWS_ACCESS_KEY_ID = "K";
    process.env.AWS_SECRET_ACCESS_KEY = "S";

    expect(isProviderEnabled("aws")).toBe(false);
  });

  it("returns false when no DB row and env has no credentials (even if enabled is not false)", () => {
    _state.selectGetReturn = undefined;
    // No credential env vars set

    expect(isProviderEnabled("aws")).toBe(false);
  });

  it("returns false when no DB row and no env config at all", () => {
    _state.selectGetReturn = undefined;

    expect(isProviderEnabled("aws")).toBe(false);
  });

  it("returns false for a provider with no known ENV_KEYS entry", () => {
    _state.selectGetReturn = undefined;

    expect(isProviderEnabled("unknown-cloud")).toBe(false);
  });
});

// ===========================================================================
// 5. getAllProviderSettings
// ===========================================================================

describe("getAllProviderSettings", () => {
  it("returns one view entry per registered provider", () => {
    _state.selectGetReturn = undefined;

    const views = getAllProviderSettings();

    expect(views).toHaveLength(2);
    const keys = views.map((v) => v.provider);
    expect(keys).toContain("aws");
    expect(keys).toContain("digitalocean");
  });

  it("populates displayName from registry", () => {
    _state.selectGetReturn = undefined;

    const views = getAllProviderSettings();
    const aws = views.find((v) => v.provider === "aws")!;

    expect(aws.displayName).toBe("Amazon Web Services");
  });

  it("sets configSource='database' and configured=true when DB row has credentials", () => {
    const creds = { accessKeyId: "K", secretAccessKey: "S", region: "us-east-1" };
    const row = makeRow({ credentials: `encrypted(${JSON.stringify(creds)})` });
    // sel().get is called multiple times per view — always return the same row
    sel().get.mockReturnValue(row);

    const views = getAllProviderSettings();
    const aws = views.find((v) => v.provider === "aws")!;

    expect(aws.configSource).toBe("database");
    expect(aws.configured).toBe(true);
  });

  it("sets configSource='env' and configured=true when env credentials are set (no DB row)", () => {
    _state.selectGetReturn = undefined;
    process.env.AWS_ACCESS_KEY_ID = "K";
    process.env.AWS_SECRET_ACCESS_KEY = "S";

    const views = getAllProviderSettings();
    const aws = views.find((v) => v.provider === "aws")!;

    expect(aws.configSource).toBe("env");
    expect(aws.configured).toBe(true);
  });

  it("sets configSource='none' and configured=false when no credentials anywhere", () => {
    _state.selectGetReturn = undefined;

    const views = getAllProviderSettings();
    const aws = views.find((v) => v.provider === "aws")!;

    expect(aws.configSource).toBe("none");
    expect(aws.configured).toBe(false);
  });

  it("does NOT expose values for password-type credential fields", () => {
    const creds = {
      accessKeyId: "AKIA_TEST",
      secretAccessKey: "super-secret",
      region: "us-east-1",
    };
    const row = makeRow({ credentials: `encrypted(${JSON.stringify(creds)})` });
    sel().get.mockReturnValue(row);

    const views = getAllProviderSettings();
    const aws = views.find((v) => v.provider === "aws")!;
    const secretField = aws.credentialFields.find((f) => f.key === "secretAccessKey")!;

    expect(secretField.hasValue).toBe(true);
    // value must be absent (or undefined) for password fields
    expect(secretField.value).toBeUndefined();
  });

  it("exposes value for non-password credential fields", () => {
    const creds = {
      accessKeyId: "AKIA_TEST",
      secretAccessKey: "super-secret",
      region: "us-east-1",
    };
    const row = makeRow({ credentials: `encrypted(${JSON.stringify(creds)})` });
    sel().get.mockReturnValue(row);

    const views = getAllProviderSettings();
    const aws = views.find((v) => v.provider === "aws")!;
    const accessKeyField = aws.credentialFields.find((f) => f.key === "accessKeyId")!;

    expect(accessKeyField.hasValue).toBe(true);
    expect(accessKeyField.value).toBe("AKIA_TEST");
  });

  it("sets hasValue=false for fields that have no value in effective credentials", () => {
    const creds = { accessKeyId: "AKIA_TEST", secretAccessKey: "S", region: "us-east-1" };
    // resourceRegions not in creds
    const row = makeRow({ credentials: `encrypted(${JSON.stringify(creds)})` });
    sel().get.mockReturnValue(row);

    const views = getAllProviderSettings();
    const aws = views.find((v) => v.provider === "aws")!;
    const regionsField = aws.credentialFields.find((f) => f.key === "resourceRegions")!;

    expect(regionsField.hasValue).toBe(false);
    expect(regionsField.value).toBeUndefined();
  });

  it("uses row.enabled for the enabled flag when a DB row exists", () => {
    const row = makeRow({ enabled: false, credentials: null });
    sel().get.mockReturnValue(row);

    const views = getAllProviderSettings();
    const aws = views.find((v) => v.provider === "aws")!;

    expect(aws.enabled).toBe(false);
  });

  it("derives enabled from env when no DB row", () => {
    _state.selectGetReturn = undefined;
    process.env.AWS_ACCESS_KEY_ID = "K";
    process.env.AWS_SECRET_ACCESS_KEY = "S";
    // AWS_ENABLED not set → default enabled

    const views = getAllProviderSettings();
    const aws = views.find((v) => v.provider === "aws")!;

    expect(aws.enabled).toBe(true);
  });

  it("propagates lastTestedAt and lastTestResult from DB row", () => {
    const row = makeRow({
      lastTestedAt: "2026-03-10T12:00:00.000Z",
      lastTestResult: true,
    });
    sel().get.mockReturnValue(row);

    const views = getAllProviderSettings();
    const aws = views.find((v) => v.provider === "aws")!;

    expect(aws.lastTestedAt).toBe("2026-03-10T12:00:00.000Z");
    expect(aws.lastTestResult).toBe(true);
  });

  it("returns null for lastTestedAt / lastTestResult when no DB row", () => {
    _state.selectGetReturn = undefined;

    const views = getAllProviderSettings();
    const aws = views.find((v) => v.provider === "aws")!;

    expect(aws.lastTestedAt).toBeNull();
    expect(aws.lastTestResult).toBeNull();
  });

  it("does not include credential values when configSource is 'none'", () => {
    _state.selectGetReturn = undefined;

    const views = getAllProviderSettings();
    const aws = views.find((v) => v.provider === "aws")!;

    for (const field of aws.credentialFields) {
      expect(field.hasValue).toBe(false);
      expect(field.value).toBeUndefined();
    }
  });
});

// ===========================================================================
// 6. upsertProviderSetting
// ===========================================================================

describe("upsertProviderSetting", () => {
  it("throws when provider is not in the registry", () => {
    expect(() =>
      upsertProviderSetting("nonexistent", { enabled: true })
    ).toThrow("Unknown provider: nonexistent");
  });

  // ── Insert new row ────────────────────────────────────────────────────────

  describe("insert (no existing row)", () => {
    beforeEach(() => {
      // getProviderSetting → not found
      _state.selectGetReturn = undefined;
      // insert().values().returning().get() → newly created row
      _state.insertReturningGetReturn = makeRow({ id: 5, enabled: true });
    });

    it("inserts a new row with enabled and encrypted credentials", () => {
      upsertProviderSetting("aws", {
        enabled: true,
        credentials: { accessKeyId: "K", secretAccessKey: "S", region: "us-east-1" },
      });

      expect(mockDb.insert).toHaveBeenCalledTimes(1);
      expect(ins().values).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "aws",
          displayName: "Amazon Web Services",
          enabled: true,
          credentials: expect.stringContaining("encrypted"),
        })
      );
      expect(ins().returning).toHaveBeenCalledTimes(1);
    });

    it("encrypts the credentials JSON before storing", () => {
      upsertProviderSetting("aws", {
        credentials: { accessKeyId: "K", secretAccessKey: "S" },
      });

      expect(mockEncrypt).toHaveBeenCalledWith(
        expect.stringContaining("accessKeyId")
      );
    });

    it("stores null credentials when data.credentials is null", () => {
      upsertProviderSetting("aws", { credentials: null });

      expect(ins().values).toHaveBeenCalledWith(
        expect.objectContaining({ credentials: null })
      );
    });

    it("defaults enabled to false when not supplied", () => {
      upsertProviderSetting("aws", {});

      expect(ins().values).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false })
      );
    });

    it("returns the newly created row", () => {
      const newRow = makeRow({ id: 5 });
      _state.insertReturningGetReturn = newRow;

      const result = upsertProviderSetting("aws", { enabled: false });

      expect(result).toEqual(newRow);
    });
  });

  // ── Update existing row ───────────────────────────────────────────────────

  describe("update (existing row found)", () => {
    const existingRow = makeRow({ id: 7, credentials: null });

    beforeEach(() => {
      // First getProviderSetting call → finds existing row
      // Second call (after update) → also returns the refreshed row
      _state.selectGetReturn = existingRow;
    });

    it("calls db.update (not db.insert) when a row already exists", () => {
      upsertProviderSetting("aws", { enabled: false });

      expect(mockDb.update).toHaveBeenCalledTimes(1);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("updates enabled when provided", () => {
      upsertProviderSetting("aws", { enabled: false });

      expect(upd().set).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false })
      );
    });

    it("includes updatedAt in every update", () => {
      upsertProviderSetting("aws", { enabled: true });

      expect(upd().set).toHaveBeenCalledWith(
        expect.objectContaining({ updatedAt: expect.any(String) })
      );
    });

    it("does not include enabled in updates when not provided", () => {
      upsertProviderSetting("aws", {});

      const setArg = (upd().set.mock.calls[0] as [Record<string, unknown>])[0];
      expect(setArg).not.toHaveProperty("enabled");
    });

    it("returns the row fetched after the update", () => {
      const updatedRow = makeRow({ id: 7, enabled: false });
      // upsertProviderSetting (update branch) makes exactly 2 select().get() calls:
      //   1) getProviderSetting() → find existing row
      //   2) re-fetch after db.update().run() → return refreshed row
      sel().get
        .mockReturnValueOnce(existingRow)  // initial existence check
        .mockReturnValueOnce(updatedRow);  // post-update re-fetch

      const result = upsertProviderSetting("aws", { enabled: false });

      expect(result).toEqual(updatedRow);
    });
  });

  // ── Credential merge logic ────────────────────────────────────────────────

  describe("credential merge logic", () => {
    it("keeps existing credential values when incoming field is empty string", () => {
      const existingCreds = { accessKeyId: "EXISTING_KEY", secretAccessKey: "EXISTING_SEC", region: "us-east-1" };
      const encryptedExisting = `encrypted(${JSON.stringify(existingCreds)})`;
      _state.selectGetReturn = makeRow({ id: 3, credentials: encryptedExisting });

      upsertProviderSetting("aws", {
        credentials: {
          accessKeyId: "",         // empty → keep existing
          secretAccessKey: "NEW_SEC", // non-empty → override
        },
      });

      // Decrypt should be called to load existing creds
      expect(mockDecrypt).toHaveBeenCalledWith(encryptedExisting);

      // Encrypt should be called with merged object (old key + new secret)
      expect(mockEncrypt).toHaveBeenCalledWith(
        expect.stringContaining("EXISTING_KEY")
      );
      expect(mockEncrypt).toHaveBeenCalledWith(
        expect.stringContaining("NEW_SEC")
      );
    });

    it("overrides credential fields when incoming value is non-empty", () => {
      const existingCreds = { accessKeyId: "OLD_KEY", secretAccessKey: "OLD_SEC" };
      _state.selectGetReturn = makeRow({
        id: 4,
        credentials: `encrypted(${JSON.stringify(existingCreds)})`,
      });

      upsertProviderSetting("aws", {
        credentials: { accessKeyId: "NEW_KEY", secretAccessKey: "NEW_SEC" },
      });

      const encryptCall = mockEncrypt.mock.calls[0][0] as string;
      const merged = JSON.parse(encryptCall) as Record<string, string>;
      expect(merged.accessKeyId).toBe("NEW_KEY");
      expect(merged.secretAccessKey).toBe("NEW_SEC");
    });

    it("starts from empty map when existing row has no credentials", () => {
      _state.selectGetReturn = makeRow({ id: 5, credentials: null });

      upsertProviderSetting("aws", {
        credentials: { accessKeyId: "K", secretAccessKey: "S" },
      });

      const encryptCall = mockEncrypt.mock.calls[0][0] as string;
      const merged = JSON.parse(encryptCall) as Record<string, string>;
      expect(merged).toEqual({ accessKeyId: "K", secretAccessKey: "S" });
    });

    it("clears credentials when data.credentials is explicitly null", () => {
      _state.selectGetReturn = makeRow({
        id: 6,
        credentials: `encrypted({"accessKeyId":"K"})`,
      });

      upsertProviderSetting("aws", { credentials: null });

      expect(upd().set).toHaveBeenCalledWith(
        expect.objectContaining({ credentials: null })
      );
      // encrypt should NOT be called when clearing
      expect(mockEncrypt).not.toHaveBeenCalled();
    });

    it("does not touch credentials in the update payload when data.credentials is undefined", () => {
      _state.selectGetReturn = makeRow({ id: 8, credentials: "enc-data" });

      upsertProviderSetting("aws", { enabled: true });

      const setArg = (upd().set.mock.calls[0] as [Record<string, unknown>])[0];
      expect(setArg).not.toHaveProperty("credentials");
      expect(mockEncrypt).not.toHaveBeenCalled();
    });
  });
});

// ===========================================================================
// 7. updateTestResult
// ===========================================================================

describe("updateTestResult", () => {
  it("updates lastTestedAt and lastTestResult when a DB row exists", () => {
    const existing = makeRow({ id: 10 });
    _state.selectGetReturn = existing;

    updateTestResult("aws", true);

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(upd().set).toHaveBeenCalledWith(
      expect.objectContaining({
        lastTestedAt: expect.any(String),
        lastTestResult: true,
        updatedAt: expect.any(String),
      })
    );
    expect(upd().run).toHaveBeenCalledTimes(1);
  });

  it("records failure result when success=false", () => {
    _state.selectGetReturn = makeRow({ id: 11 });

    updateTestResult("aws", false);

    expect(upd().set).toHaveBeenCalledWith(
      expect.objectContaining({ lastTestResult: false })
    );
  });

  it("sets updatedAt to the same ISO timestamp as lastTestedAt", () => {
    _state.selectGetReturn = makeRow({ id: 12 });

    updateTestResult("aws", true);

    const setArg = (upd().set.mock.calls[0] as [Record<string, string>])[0];
    expect(setArg.lastTestedAt).toBe(setArg.updatedAt);
  });

  it("auto-creates a row (insert) when no row exists and provider is registered", () => {
    _state.selectGetReturn = undefined;

    updateTestResult("aws", true);

    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    expect(ins().values).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "aws",
        displayName: "Amazon Web Services",
        enabled: false,
        lastTestResult: true,
        lastTestedAt: expect.any(String),
      })
    );
    expect(ins().run).toHaveBeenCalledTimes(1);
  });

  it("auto-creates row with correct failure result", () => {
    _state.selectGetReturn = undefined;

    updateTestResult("digitalocean", false);

    expect(ins().values).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "digitalocean",
        lastTestResult: false,
      })
    );
  });

  it("does nothing when no row exists and provider is NOT in the registry", () => {
    _state.selectGetReturn = undefined;

    updateTestResult("unknown-provider", true);

    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("does not call insert when a row is found", () => {
    _state.selectGetReturn = makeRow({ id: 20 });

    updateTestResult("aws", false);

    expect(mockDb.insert).not.toHaveBeenCalled();
  });
});
