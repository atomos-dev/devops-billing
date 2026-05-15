/**
 * Unit tests for the sync service (src/services/sync.ts).
 *
 * Covers:
 * - syncProvider: full sync, concurrency lock, partial/complete failures, sync log recording
 * - syncAll: sequential provider execution, aggregated results
 * - Upsert logic: bill dedup by provider+billingPeriod, resource dedup by provider+resourceId,
 *   manual category preservation on resource update
 *
 * Mocks:
 * - @/db (drizzle DB) — chainable query builder
 * - ./category (classifyResource) — deterministic classification
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type {
  BillingProvider,
  BillData,
  BillItemData,
  ResourceData,
} from "@/providers/types";
import { billItems } from "@/db/schema";

// ---------------------------------------------------------------------------
// Hoisted mock state — vi.hoisted runs before vi.mock factories execute
// ---------------------------------------------------------------------------

const {
  mockDb,
  mockClassifyResource,
  _state,
} = vi.hoisted(() => {
  /**
   * Shared mutable state bucket.
   * Tests set these to control what chainable DB terminal methods return.
   */
  const _state = {
    dbGetReturn: undefined as unknown,
    dbAllReturn: [] as unknown[],
    dbReturningGetReturn: { id: 1 } as unknown,
    /** Current chain instances — replaced in beforeEach */
    insertChain: null as ReturnType<typeof _createChainMock> | null,
    selectChain: null as ReturnType<typeof _createChainMock> | null,
    updateChain: null as ReturnType<typeof _createChainMock> | null,
    deleteChain: null as ReturnType<typeof _createChainMock> | null,
  };

  /**
   * Build a chainable mock that supports:
   *   db.insert(table).values(data).returning().get()
   *   db.insert(table).values(data).run()
   *   db.select().from(table).where(cond).get()
   *   db.select().from(table).where(cond).all()
   *   db.update(table).set(data).where(cond).run()
   *   db.delete(table).where(cond).run()
   */
  function _createChainMock() {
    const run = vi.fn();
    const get = vi.fn(() => _state.dbGetReturn);
    const all = vi.fn(() => _state.dbAllReturn);
    const returningGet = vi.fn(() => _state.dbReturningGetReturn);
    const returning = vi.fn(() => ({ get: returningGet }));

    const chain: Record<string, Mock> = {
      values: vi.fn(),
      set: vi.fn(),
      from: vi.fn(),
      where: vi.fn(),
      returning,
      get,
      all,
      run,
    };

    for (const key of ["values", "set", "from", "where"]) {
      chain[key].mockReturnValue(chain);
    }
    chain.returning.mockReturnValue({ get: returningGet });

    return chain;
  }

  // Expose createChainMock on _state so beforeEach can use it
  const createChainMock = _createChainMock;

  const mockDb = {
    insert: vi.fn(() => _state.insertChain),
    select: vi.fn(() => _state.selectChain),
    update: vi.fn(() => _state.updateChain),
    delete: vi.fn(() => _state.deleteChain),
    transaction: vi.fn(),
    _createChainMock: createChainMock,
  };

  mockDb.transaction.mockImplementation((transaction) => transaction(mockDb));

  const mockClassifyResource = vi.fn(() => "other");

  return { mockDb, mockClassifyResource, _state };
});

// ---------------------------------------------------------------------------
// Module mocks (factories reference only hoisted values)
// ---------------------------------------------------------------------------

vi.mock("@/db", () => ({
  db: mockDb,
}));

vi.mock("../category", () => ({
  classifyResource: (...args: unknown[]) =>
    mockClassifyResource(
      args[0] as Record<string, string> | undefined,
      args[1] as string | undefined
    ),
}));

// ---------------------------------------------------------------------------
// Import subjects AFTER mocks are wired
// ---------------------------------------------------------------------------

import { syncProvider, syncAll } from "../sync";

// ---------------------------------------------------------------------------
// Helper: create a mock BillingProvider with vi.fn() methods
// ---------------------------------------------------------------------------

function createMockProvider(
  name = "test-provider",
  overrides: Partial<BillingProvider> = {}
): BillingProvider {
  return {
    name,
    displayName: overrides.displayName ?? `Test Provider (${name})`,
    fetchBills: vi.fn<[Date, Date], Promise<BillData[]>>().mockResolvedValue([]),
    fetchBillItems: vi.fn<[string], Promise<BillItemData[]>>().mockResolvedValue([]),
    fetchResources: vi.fn<[], Promise<ResourceData[]>>().mockResolvedValue([]),
    testConnection: vi.fn<[], Promise<boolean>>().mockResolvedValue(true),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Convenience aliases (point into _state so tests can read chain mocks)
// ---------------------------------------------------------------------------

/** Get current insert chain from shared state */
function insertChain() {
  return _state.insertChain!;
}
function selectChain() {
  return _state.selectChain!;
}
function updateChain() {
  return _state.updateChain!;
}
function deleteChain() {
  return _state.deleteChain!;
}

/**
 * Extract persisted bill-item payloads from shared insert mock calls.
 * The same insert chain is reused for sync logs, bills, resources, and bill items,
 * so tests filter by the presence of a numeric billId to isolate bill-item writes.
 */
function getBillItemInsertPayloads() {
  return insertChain().values.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((payload) => typeof payload.billId === "number");
}

/**
 * Extract bill-item update payloads from shared update mock calls.
 * Sync-log/resource/bill updates share the same chain, so bill-item updates are
 * identified by the presence of a numeric billId in the .set() payload.
 */
function getBillItemUpdatePayloads() {
  return updateChain().set.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((payload) => typeof payload.billId === "number");
}

/**
 * Extract delete targets that operate on the billItems table.
 */
function getBillItemDeleteTableCalls() {
  return mockDb.delete.mock.calls.filter(([table]) => table === billItems);
}

/**
 * Drizzle SQL expressions are nested query-chunk trees. Flatten them so tests can
 * assert delete predicates target the current bill without depending on internals
 * beyond chunk names and parameter values.
 */
function flattenSqlChunks(sql: unknown): unknown[] {
  if (!sql || typeof sql !== "object") {
    return [];
  }

  const queryChunks = (sql as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(queryChunks)) {
    return [sql];
  }

  return queryChunks.flatMap((chunk) => flattenSqlChunks(chunk));
}

function getSqlParamValues(sql: unknown): unknown[] {
  return flattenSqlChunks(sql)
    .filter(
      (chunk): chunk is { constructor: { name: string }; value: unknown } =>
        typeof chunk === "object" &&
        chunk !== null &&
        (chunk as { constructor?: { name?: string } }).constructor?.name === "Param"
    )
    .map((chunk) => chunk.value);
}

function getSqlColumnNames(sql: unknown): string[] {
  return flattenSqlChunks(sql)
    .filter(
      (chunk): chunk is { name: string } =>
        typeof chunk === "object" && chunk !== null && typeof (chunk as { name?: unknown }).name === "string"
    )
    .map((chunk) => chunk.name);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Recreate chains so each test starts fresh
  _state.insertChain = mockDb._createChainMock();
  _state.selectChain = mockDb._createChainMock();
  _state.updateChain = mockDb._createChainMock();
  _state.deleteChain = mockDb._createChainMock();

  mockDb.insert.mockImplementation(() => _state.insertChain);
  mockDb.select.mockImplementation(() => _state.selectChain);
  mockDb.update.mockImplementation(() => _state.updateChain);
  mockDb.delete.mockImplementation(() => _state.deleteChain);
  mockDb.transaction.mockImplementation((transaction) => transaction(mockDb));

  // Reset defaults
  _state.dbGetReturn = undefined;
  _state.dbAllReturn = [];
  _state.dbReturningGetReturn = { id: 1 };
  mockClassifyResource.mockReturnValue("other");
});

// ===========================================================================
// syncProvider
// ===========================================================================

describe("syncProvider", () => {
  // -----------------------------------------------------------------------
  // Successful full sync
  // -----------------------------------------------------------------------
  describe("successful full sync (bills + items + resources)", () => {
    it("should fetch bills, items, and resources, then record a success sync log", async () => {
      const billsData: BillData[] = [
        { provider: "aws", billingPeriod: "2026-01", totalAmount: 100 },
        { provider: "aws", billingPeriod: "2026-02", totalAmount: 200 },
      ];

      const itemsData: BillItemData[] = [
        { service: "EC2", amount: 80, region: "us-east-1", resourceId: "i-111" },
      ];

      const resourcesData: ResourceData[] = [
        {
          provider: "aws",
          resourceId: "i-111",
          resourceName: "dpn-node-1",
          tags: { usage: "dpn" },
        },
      ];

      const provider = createMockProvider("aws", {
        fetchBills: vi.fn().mockResolvedValue(billsData),
        fetchBillItems: vi.fn().mockResolvedValue(itemsData),
        fetchResources: vi.fn().mockResolvedValue(resourcesData),
      });

      // Sync log insert returns id: 42
      _state.dbReturningGetReturn = { id: 42 };

      // For upsertBill, upsertBillItem, upsertResource — no existing records
      selectChain().get.mockImplementation(() => undefined);
      selectChain().all.mockImplementation(() => [
        { id: 10, billingPeriod: "2026-01", provider: "aws" },
        { id: 11, billingPeriod: "2026-02", provider: "aws" },
      ]);

      const result = await syncProvider(provider, "manual");

      // Verify provider methods were called
      expect(provider.fetchBills).toHaveBeenCalledTimes(1);
      expect(provider.fetchResources).toHaveBeenCalledTimes(1);
      // Items fetched once per existing bill
      expect(provider.fetchBillItems).toHaveBeenCalledTimes(2);
      expect(provider.fetchBillItems).toHaveBeenCalledWith("2026-01");
      expect(provider.fetchBillItems).toHaveBeenCalledWith("2026-02");

      // Result should be success
      expect(result.status).toBe("success");
      expect(result.provider).toBe("aws");
      expect(result.syncLogId).toBe(42);
      // 2 bills + 2 items (one per bill period) + 1 resource = 5
      expect(result.recordsSynced).toBe(5);
      expect(result.errorMessage).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Concurrent sync prevention
  // -----------------------------------------------------------------------
  describe("concurrent sync prevention (activeSyncs lock)", () => {
    it("should reject a second sync while one is running for the same provider", async () => {
      // Provider whose fetchBills hangs until we resolve it manually
      let resolveFetch!: (value: BillData[]) => void;
      const hangingPromise = new Promise<BillData[]>((resolve) => {
        resolveFetch = resolve;
      });

      const provider = createMockProvider("gcp", {
        fetchBills: vi.fn().mockReturnValue(hangingPromise),
      });

      // Start the first sync (will hang on fetchBills)
      const firstSync = syncProvider(provider, "scheduled");

      // Attempt a second sync immediately
      const secondResult = await syncProvider(provider, "manual");

      expect(secondResult.status).toBe("failed");
      expect(secondResult.errorMessage).toContain("already in progress");
      expect(secondResult.syncLogId).toBe(-1);
      expect(secondResult.recordsSynced).toBe(0);

      // Unblock the first sync so it finishes (cleanup)
      resolveFetch([]);
      selectChain().all.mockReturnValue([]);
      await firstSync;
    });

    it("should allow a new sync after the previous one finishes", async () => {
      const provider = createMockProvider("gcp");
      selectChain().all.mockReturnValue([]);

      const result1 = await syncProvider(provider, "manual");
      expect(result1.status).toBe("success");

      const result2 = await syncProvider(provider, "scheduled");
      expect(result2.status).toBe("success");
    });
  });

  // -----------------------------------------------------------------------
  // Partial failure handling
  // -----------------------------------------------------------------------
  describe("partial failure handling", () => {
    it("should return 'partial' when bills fetch fails but resources succeed", async () => {
      const provider = createMockProvider("aws", {
        fetchBills: vi.fn().mockRejectedValue(new Error("API rate limit")),
        fetchResources: vi.fn().mockResolvedValue([
          { provider: "aws", resourceId: "r-1", resourceName: "node-a" },
        ]),
      });

      selectChain().all.mockReturnValue([]); // no existing bills for item fetch

      const result = await syncProvider(provider, "manual");

      expect(result.status).toBe("partial");
      expect(result.errorMessage).toContain("API rate limit");
      // Only the resource was synced
      expect(result.recordsSynced).toBe(1);
    });

    it("should return 'partial' when resources fetch fails but bills succeed", async () => {
      const provider = createMockProvider("aws", {
        fetchBills: vi.fn().mockResolvedValue([
          { provider: "aws", billingPeriod: "2026-03", totalAmount: 50 },
        ]),
        fetchResources: vi.fn().mockRejectedValue(new Error("Network timeout")),
      });

      selectChain().all.mockReturnValue([]); // no existing bills for item fetch

      const result = await syncProvider(provider, "manual");

      expect(result.status).toBe("partial");
      expect(result.errorMessage).toContain("Network timeout");
      // 1 bill synced, 0 resources
      expect(result.recordsSynced).toBe(1);
    });

    it("should return 'partial' when a single bill-item period fails", async () => {
      const provider = createMockProvider("aws", {
        fetchBills: vi.fn().mockResolvedValue([]),
        fetchBillItems: vi
          .fn()
          .mockResolvedValueOnce([{ service: "EC2", amount: 10 }])
          .mockRejectedValueOnce(new Error("period 02 error")),
        fetchResources: vi.fn().mockResolvedValue([]),
      });

      // Two existing bills — first period succeeds, second fails
      selectChain().all.mockReturnValue([
        { id: 1, billingPeriod: "2026-01", provider: "aws" },
        { id: 2, billingPeriod: "2026-02", provider: "aws" },
      ]);

      const result = await syncProvider(provider, "scheduled");

      expect(result.status).toBe("partial");
      expect(result.errorMessage).toContain("period 02 error");
      // 1 item from the first period
      expect(result.recordsSynced).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Complete failure handling
  // -----------------------------------------------------------------------
  describe("complete failure handling", () => {
    it("should return 'partial' when all three fetches fail (all errors collected)", async () => {
      const provider = createMockProvider("aws", {
        fetchBills: vi.fn().mockRejectedValue(new Error("bills-err")),
        fetchResources: vi.fn().mockRejectedValue(new Error("resources-err")),
      });

      selectChain().all.mockReturnValue([]);

      const result = await syncProvider(provider, "manual");

      // Bills and resources both failed; items had no bills to iterate
      expect(result.status).toBe("partial");
      expect(result.errorMessage).toContain("bills-err");
      expect(result.errorMessage).toContain("resources-err");
      expect(result.recordsSynced).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Sync log recording
  // -----------------------------------------------------------------------
  describe("sync log recording", () => {
    it("should create a sync log on start and update it on completion (success)", async () => {
      _state.dbReturningGetReturn = { id: 99 };
      selectChain().all.mockReturnValue([]);

      const provider = createMockProvider("do");
      await syncProvider(provider, "scheduled");

      // Insert sync log with status "running"
      expect(mockDb.insert).toHaveBeenCalled();
      expect(insertChain().values).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "do",
          syncType: "scheduled",
          status: "running",
        })
      );

      // Update sync log with final status
      expect(mockDb.update).toHaveBeenCalled();
      expect(updateChain().set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "success",
          recordsSynced: 0,
        })
      );
    });

    it("should update sync log with 'partial' and error message on partial failure", async () => {
      _state.dbReturningGetReturn = { id: 55 };
      selectChain().all.mockReturnValue([]);

      const provider = createMockProvider("aws", {
        fetchBills: vi.fn().mockRejectedValue(new Error("oops")),
      });

      const result = await syncProvider(provider, "manual");

      expect(result.syncLogId).toBe(55);
      expect(updateChain().set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "partial",
          errorMessage: expect.stringContaining("oops"),
        })
      );
    });
  });

  // -----------------------------------------------------------------------
  // Backfill months parameter
  // -----------------------------------------------------------------------
  describe("backfillMonths parameter", () => {
    it("should pass the calculated start date to fetchBills", async () => {
      const provider = createMockProvider("aws");
      selectChain().all.mockReturnValue([]);

      await syncProvider(provider, "manual", 3);

      const [start] = (provider.fetchBills as Mock).mock.calls[0] as [Date, Date];
      // start should be ~3 months ago, first of the month
      expect(start.getDate()).toBe(1);
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
      expect(start.getMonth()).toBe(threeMonthsAgo.getMonth());
    });
  });
});

// ===========================================================================
// syncAll
// ===========================================================================

describe("syncAll", () => {
  it("should run all providers sequentially and return array of results", async () => {
    const providerA = createMockProvider("aws");
    const providerB = createMockProvider("do");
    selectChain().all.mockReturnValue([]);

    const providers = new Map<string, BillingProvider>([
      ["aws", providerA],
      ["do", providerB],
    ]);

    _state.dbReturningGetReturn = { id: 1 };

    const results = await syncAll(providers, "scheduled", 3);

    expect(results).toHaveLength(2);
    expect(results[0].provider).toBe("aws");
    expect(results[1].provider).toBe("do");
    // Each provider's fetchBills should be called once
    expect(providerA.fetchBills).toHaveBeenCalledTimes(1);
    expect(providerB.fetchBills).toHaveBeenCalledTimes(1);
  });

  it("should return results even if one provider fails", async () => {
    const providerA = createMockProvider("aws", {
      fetchBills: vi.fn().mockRejectedValue(new Error("aws-fail")),
    });
    const providerB = createMockProvider("do");
    selectChain().all.mockReturnValue([]);

    const providers = new Map<string, BillingProvider>([
      ["aws", providerA],
      ["do", providerB],
    ]);

    const results = await syncAll(providers, "manual");

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe("partial");
    expect(results[0].errorMessage).toContain("aws-fail");
    expect(results[1].status).toBe("success");
  });
});

// ===========================================================================
// Upsert logic (tested implicitly through syncProvider)
// ===========================================================================

describe("upsert logic", () => {
  // -----------------------------------------------------------------------
  // Bills upsert by provider + billingPeriod
  // -----------------------------------------------------------------------
  describe("bills upserted by provider + billingPeriod", () => {
    it("should insert a new bill when none exists", async () => {
      const provider = createMockProvider("aws", {
        fetchBills: vi.fn().mockResolvedValue([
          { provider: "aws", billingPeriod: "2026-03", totalAmount: 300, rawData: "{}" },
        ]),
      });

      selectChain().get.mockReturnValue(undefined); // no existing bill
      selectChain().all.mockReturnValue([]);

      await syncProvider(provider, "manual");

      // The insert chain's .values should be called with bill data
      expect(insertChain().values).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "aws",
          billingPeriod: "2026-03",
          totalAmount: 300,
        })
      );
    });

    it("should update an existing bill when one is found", async () => {
      const provider = createMockProvider("aws", {
        fetchBills: vi.fn().mockResolvedValue([
          { provider: "aws", billingPeriod: "2026-03", totalAmount: 999 },
        ]),
      });

      // First .get() for upsertBill — existing bill found
      selectChain().get.mockReturnValueOnce({
        id: 7,
        provider: "aws",
        billingPeriod: "2026-03",
      });
      selectChain().all.mockReturnValue([]);

      await syncProvider(provider, "manual");

      // db.update should be called with the new totalAmount
      expect(updateChain().set).toHaveBeenCalledWith(
        expect.objectContaining({
          totalAmount: 999,
        })
      );
    });
  });

  // -----------------------------------------------------------------------
  // Resources upserted by provider + resourceId
  // -----------------------------------------------------------------------
  describe("resources upserted by provider + resourceId", () => {
    it("should insert a new resource when none exists", async () => {
      const provider = createMockProvider("aws", {
        fetchResources: vi.fn().mockResolvedValue([
          {
            provider: "aws",
            resourceId: "i-abc",
            resourceName: "my-server",
            tags: { team: "devops" },
            status: "running",
          },
        ]),
      });

      mockClassifyResource.mockReturnValue("devops");
      selectChain().get.mockReturnValue(undefined);
      selectChain().all.mockReturnValue([]);

      await syncProvider(provider, "manual");

      expect(mockClassifyResource).toHaveBeenCalledWith(
        { team: "devops" },
        "my-server"
      );
      expect(insertChain().values).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "aws",
          resourceId: "i-abc",
          resourceName: "my-server",
          usageCategory: "devops",
        })
      );
    });

    it("should update an existing resource when one is found", async () => {
      const provider = createMockProvider("aws", {
        fetchResources: vi.fn().mockResolvedValue([
          {
            provider: "aws",
            resourceId: "i-abc",
            resourceName: "updated-name",
            status: "stopped",
          },
        ]),
      });

      mockClassifyResource.mockReturnValue("other");
      selectChain().get.mockReturnValue({
        id: 20,
        provider: "aws",
        resourceId: "i-abc",
        usageCategory: "other",
      });
      selectChain().all.mockReturnValue([]);

      await syncProvider(provider, "manual");

      expect(updateChain().set).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceName: "updated-name",
          status: "stopped",
        })
      );
    });
  });

  // -----------------------------------------------------------------------
  // Category preserved on resource update when manual override exists
  // -----------------------------------------------------------------------
  describe("manual category preservation on resource update", () => {
    it("should preserve non-'other' usageCategory when classifyResource returns 'other'", async () => {
      const provider = createMockProvider("aws", {
        fetchResources: vi.fn().mockResolvedValue([
          {
            provider: "aws",
            resourceId: "i-manual",
            resourceName: "unknown-server",
          },
        ]),
      });

      mockClassifyResource.mockReturnValue("other");

      // Existing resource has a manually assigned category "dpn"
      selectChain().get.mockReturnValue({
        id: 30,
        provider: "aws",
        resourceId: "i-manual",
        usageCategory: "dpn",
      });
      selectChain().all.mockReturnValue([]);

      await syncProvider(provider, "manual");

      // Find the resource-update .set() call (not the sync-log update)
      const setCalls = updateChain().set.mock.calls;
      const resourceUpdateCall = setCalls.find(
        (call) => (call[0] as Record<string, unknown>).resourceId === "i-manual"
      );
      expect(resourceUpdateCall).toBeDefined();
      // usageCategory should NOT be present (deleted to preserve manual override)
      expect(resourceUpdateCall![0]).not.toHaveProperty("usageCategory");
    });

    it("should overwrite usageCategory when classifyResource returns a non-'other' value", async () => {
      const provider = createMockProvider("aws", {
        fetchResources: vi.fn().mockResolvedValue([
          {
            provider: "aws",
            resourceId: "i-auto",
            resourceName: "dpn-node-5",
            tags: { usage: "dpn" },
          },
        ]),
      });

      mockClassifyResource.mockReturnValue("dpn");

      // Existing resource had "other"
      selectChain().get.mockReturnValue({
        id: 31,
        provider: "aws",
        resourceId: "i-auto",
        usageCategory: "other",
      });
      selectChain().all.mockReturnValue([]);

      await syncProvider(provider, "manual");

      expect(updateChain().set).toHaveBeenCalledWith(
        expect.objectContaining({
          usageCategory: "dpn",
        })
      );
    });
  });

  // -----------------------------------------------------------------------
  // Bill items upsert with resource category lookup
  // -----------------------------------------------------------------------
  describe("bill items upsert with resource category lookup", () => {
    it("should delete existing DigitalOcean bill items for the current bill before inserting replacement items", async () => {
      const provider = createMockProvider("digitalocean", {
        fetchBills: vi.fn().mockResolvedValue([]),
        fetchBillItems: vi.fn().mockResolvedValue([
          {
            service: "Droplets",
            amount: 42,
            region: "nyc1",
            resourceId: "do-123",
            usageUnit: "hour",
          },
        ]),
      });

      selectChain().all.mockReturnValue([
        { id: 12, billingPeriod: "2026-02", provider: "digitalocean" },
      ]);
      selectChain().get.mockReturnValue(undefined);

      await syncProvider(provider, "manual");

      const billItemDeleteCalls = getBillItemDeleteTableCalls();
      const billItemInsertPayloads = getBillItemInsertPayloads();

      expect(billItemDeleteCalls).toHaveLength(1);
      expect(mockDb.delete).toHaveBeenCalledWith(billItems);
      expect(deleteChain().where).toHaveBeenCalledTimes(1);
      expect(deleteChain().run).toHaveBeenCalledTimes(1);
      expect(getSqlColumnNames(deleteChain().where.mock.calls[0][0])).toContain("bill_id");
      expect(getSqlParamValues(deleteChain().where.mock.calls[0][0])).toContain(12);
      expect(billItemInsertPayloads).toContainEqual(
        expect.objectContaining({
          billId: 12,
          service: "Droplets",
          amount: 42,
        })
      );

      const deleteInvocation = deleteChain().run.mock.invocationCallOrder[0];
      const insertInvocation = insertChain().values.mock.invocationCallOrder.find((order, index) => {
        const payload = insertChain().values.mock.calls[index]?.[0] as
          | Record<string, unknown>
          | undefined;
        return order > deleteInvocation && typeof payload?.billId === "number";
      });
      expect(insertInvocation).toBeDefined();
    });

    it("should repair previously incorrect DigitalOcean bill items via delete and replacement inserts", async () => {
      const provider = createMockProvider("digitalocean", {
        fetchBills: vi.fn().mockResolvedValue([]),
        fetchBillItems: vi.fn().mockResolvedValue([
          {
            service: "Spaces",
            amount: 9.5,
            region: "sfo3",
            resourceId: "space-1",
            usageUnit: "GB",
          },
        ]),
      });

      selectChain().all.mockReturnValue([
        { id: 21, billingPeriod: "2026-01", provider: "digitalocean" },
      ]);
      // Resource lookup may still occur in the replacement path, so only assert on
      // bill-item persistence behavior rather than all select().get() activity.
      selectChain().get.mockReturnValue({
        id: 999,
        provider: "digitalocean",
        resourceId: "space-1",
        usageCategory: "other",
        resourceName: "legacy-space-name",
      });

      await syncProvider(provider, "manual");

      const billItemDeleteCalls = getBillItemDeleteTableCalls();
      const billItemInsertPayloads = getBillItemInsertPayloads();
      const billItemUpdatePayloads = getBillItemUpdatePayloads();

      expect(billItemDeleteCalls).toHaveLength(1);
      expect(deleteChain().run).toHaveBeenCalledTimes(1);
      expect(getSqlColumnNames(deleteChain().where.mock.calls[0][0])).toContain("bill_id");
      expect(getSqlParamValues(deleteChain().where.mock.calls[0][0])).toContain(21);
      expect(billItemInsertPayloads).toContainEqual(
        expect.objectContaining({
          billId: 21,
          service: "Spaces",
          amount: 9.5,
          resourceId: "space-1",
        })
      );
      expect(billItemUpdatePayloads).toEqual([]);
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    });

    it("should delete stale DigitalOcean current-month items when no invoice items exist", async () => {
      const provider = createMockProvider("digitalocean", {
        fetchBills: vi.fn().mockResolvedValue([]),
        fetchBillItems: vi.fn().mockResolvedValue([]),
      });

      selectChain().all.mockReturnValue([
        { id: 25, billingPeriod: "2026-03", provider: "digitalocean" },
      ]);

      await syncProvider(provider, "manual");

      expect(getBillItemDeleteTableCalls()).toHaveLength(1);
      expect(getSqlParamValues(deleteChain().where.mock.calls[0][0])).toContain(25);
      expect(getBillItemInsertPayloads()).toEqual([]);
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    });

    it("should keep AWS on the old per-item upsert path without bill-level replacement deletes", async () => {
      const provider = createMockProvider("aws", {
        fetchBills: vi.fn().mockResolvedValue([]),
        fetchBillItems: vi.fn().mockResolvedValue([
          {
            service: "EC2",
            amount: 17,
            region: "us-east-1",
            resourceId: "i-aws-1",
            usageUnit: "hours",
          },
        ]),
      });

      selectChain().all.mockReturnValue([
        { id: 30, billingPeriod: "2026-02", provider: "aws" },
      ]);
      selectChain().get.mockReturnValue(undefined);

      await syncProvider(provider, "manual");

      expect(mockDb.delete).not.toHaveBeenCalled();
      expect(selectChain().get).toHaveBeenCalled();
      expect(insertChain().values).toHaveBeenCalledWith(
        expect.objectContaining({
          billId: 30,
          service: "EC2",
          amount: 17,
        })
      );
    });

    it("should look up resource for category when bill item has resourceId", async () => {
      const provider = createMockProvider("aws", {
        fetchBills: vi.fn().mockResolvedValue([]),
        fetchBillItems: vi.fn().mockResolvedValue([
          { service: "EC2", amount: 50, resourceId: "i-123", region: "us-east-1" },
        ]),
      });

      selectChain().all.mockReturnValue([
        { id: 5, billingPeriod: "2026-01", provider: "aws" },
      ]);

      // 1st .get(): resource lookup → found with category "dpn"
      // 2nd .get(): existing item check → not found (insert)
      selectChain()
        .get.mockReturnValueOnce({
          id: 100,
          provider: "aws",
          resourceId: "i-123",
          usageCategory: "dpn",
          resourceName: "dpn-node",
        })
        .mockReturnValueOnce(undefined);

      await syncProvider(provider, "manual");

      expect(insertChain().values).toHaveBeenCalledWith(
        expect.objectContaining({
          usageCategory: "dpn",
          billId: 5,
          service: "EC2",
        })
      );
    });

    it("should fall back to 'other' category when resource not found", async () => {
      const provider = createMockProvider("aws", {
        fetchBills: vi.fn().mockResolvedValue([]),
        fetchBillItems: vi.fn().mockResolvedValue([
          { service: "S3", amount: 5, resourceId: "bucket-xyz" },
        ]),
      });

      selectChain().all.mockReturnValue([
        { id: 6, billingPeriod: "2026-02", provider: "aws" },
      ]);

      // Resource not found, item not found
      selectChain().get.mockReturnValue(undefined);

      await syncProvider(provider, "manual");

      expect(insertChain().values).toHaveBeenCalledWith(
        expect.objectContaining({
          usageCategory: "other",
          service: "S3",
        })
      );
    });

    it("should use resource name when bill item has no resourceName", async () => {
      const provider = createMockProvider("aws", {
        fetchBills: vi.fn().mockResolvedValue([]),
        fetchBillItems: vi.fn().mockResolvedValue([
          { service: "EC2", amount: 10, resourceId: "i-999" },
        ]),
      });

      selectChain().all.mockReturnValue([
        { id: 8, billingPeriod: "2026-03", provider: "aws" },
      ]);

      // Resource found with a name; item not found
      selectChain()
        .get.mockReturnValueOnce({
          id: 200,
          provider: "aws",
          resourceId: "i-999",
          usageCategory: "mainnet",
          resourceName: "mainnet-validator",
        })
        .mockReturnValueOnce(undefined);

      await syncProvider(provider, "manual");

      expect(insertChain().values).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceName: "mainnet-validator",
          usageCategory: "mainnet",
        })
      );
    });

    it("should update an existing bill item when nullable identity fields are empty", async () => {
      const provider = createMockProvider("aws", {
        fetchBills: vi.fn().mockResolvedValue([]),
        fetchBillItems: vi.fn().mockResolvedValue([
          { service: "EC2 - Other", amount: 12.34 },
        ]),
      });

      selectChain().all.mockReturnValue([
        { id: 7, billingPeriod: "2026-03", provider: "aws" },
      ]);

      // No resource lookup runs because resourceId is absent.
      // Existing bill item should still be found and updated instead of inserted.
      selectChain().get.mockReturnValue({
        id: 900,
        billId: 7,
        service: "EC2 - Other",
        region: null,
        resourceId: null,
        usageUnit: null,
      });

      await syncProvider(provider, "manual");

      expect(updateChain().set).toHaveBeenCalledWith(
        expect.objectContaining({
          billId: 7,
          service: "EC2 - Other",
          amount: 12.34,
          region: null,
          resourceId: null,
          usageUnit: null,
        })
      );
      expect(insertChain().values).not.toHaveBeenCalledWith(
        expect.objectContaining({
          billId: 7,
          service: "EC2 - Other",
        })
      );
    });
  });
});

// ===========================================================================
// Edge cases
// ===========================================================================

describe("edge cases", () => {
  it("should release the lock even when the top-level catch fires", async () => {
    _state.dbReturningGetReturn = { id: 1 };

    const provider = createMockProvider("boom", {
      fetchBills: vi.fn().mockImplementation(() => {
        throw new Error("catastrophic");
      }),
    });

    selectChain().all.mockReturnValue([]);

    await syncProvider(provider, "manual");

    // Lock should be released — a second sync should NOT say "already in progress"
    const result = await syncProvider(provider, "scheduled");
    expect(result.errorMessage).not.toContain("already in progress");
  });

  it("should handle resource tags serialization to JSON", async () => {
    const provider = createMockProvider("aws", {
      fetchResources: vi.fn().mockResolvedValue([
        {
          provider: "aws",
          resourceId: "i-tag",
          tags: { env: "prod", team: "dpn" },
        },
      ]),
    });

    selectChain().get.mockReturnValue(undefined);
    selectChain().all.mockReturnValue([]);
    mockClassifyResource.mockReturnValue("dpn");

    await syncProvider(provider, "manual");

    expect(insertChain().values).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: JSON.stringify({ env: "prod", team: "dpn" }),
      })
    );
  });

  it("should set tags to null when resource has no tags", async () => {
    const provider = createMockProvider("aws", {
      fetchResources: vi.fn().mockResolvedValue([
        { provider: "aws", resourceId: "i-notag" },
      ]),
    });

    selectChain().get.mockReturnValue(undefined);
    selectChain().all.mockReturnValue([]);

    await syncProvider(provider, "manual");

    expect(insertChain().values).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: null,
      })
    );
  });

  it("should handle non-Error thrown values gracefully", async () => {
    const provider = createMockProvider("aws", {
      fetchBills: vi.fn().mockRejectedValue("string-error"),
    });

    selectChain().all.mockReturnValue([]);

    const result = await syncProvider(provider, "manual");

    expect(result.status).toBe("partial");
    expect(result.errorMessage).toContain("string-error");
  });
});
