/**
 * Unit tests for src/providers/digitalocean.ts — DigitalOceanProvider
 *
 * Covers:
 * - fetchBills(): invoice billing period mapping and current-month balance merge
 * - fetchBillItems(): invoice lookup and line-item normalization
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DigitalOceanProvider } from "../digitalocean";
import { aggregateMbpsToDailyGib } from "../digitalocean";

function createJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

describe("DigitalOceanProvider", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const provider = new DigitalOceanProvider({ apiToken: "do-token" });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-19T08:00:00Z"));
    vi.stubGlobal("fetch", fetchMock);
  });

  it("uses invoice billing_period for historical bills and keeps current month from balance", async () => {
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          invoices: [
            {
              invoice_uuid: "inv-feb",
              invoice_period: "2026-02",
              amount: "2577.88",
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          month_to_date_usage: "1254.82",
        })
      );

    const bills = await provider.fetchBills(
      new Date("2026-02-01T00:00:00Z"),
      new Date("2026-03-19T00:00:00Z")
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.digitalocean.com/v2/customers/my/invoices",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer do-token",
        }),
      })
    );
    expect(bills).toEqual([
      expect.objectContaining({
        provider: "digitalocean",
        billingPeriod: "2026-02",
        totalAmount: 2577.88,
      }),
      expect.objectContaining({
        provider: "digitalocean",
        billingPeriod: "2026-03",
        totalAmount: 1254.82,
      }),
    ]);
  });

  it("returns invoice line items for the matching billing period", async () => {
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          invoices: [
            {
              invoice_uuid: "inv-feb",
              invoice_period: "2026-02",
              amount: "2577.88",
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          invoice_items: [
            {
              product: "Droplets",
              region: "sgp1",
              resource_uuid: "123456",
              description: "worker-01",
              amount: "42.50",
              duration: "120",
              duration_unit: "Hrs",
              start_time: "2026-02-01T00:00:00Z",
              end_time: "2026-02-05T23:59:59Z",
            },
          ],
          links: {
            pages: {
              next: "https://api.digitalocean.com/v2/customers/team/invoices/inv-feb?page=2&per_page=20",
            },
          },
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          invoice_items: [
            {
              product: "Spaces Subscription",
              description: "Spaces ($5/mo 250GiB storage & 1TiB bandwidth)",
              amount: "5.00",
              duration: "1",
              duration_unit: "Month",
              start_time: "2026-02-01T00:00:00Z",
              end_time: "2026-03-01T00:00:00Z",
            },
          ],
        })
      );

    const items = await provider.fetchBillItems("2026-02");

    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://api.digitalocean.com/v2/customers/team/invoices/inv-feb?page=2&per_page=20",
      expect.any(Object)
    );
    expect(items).toEqual([
      {
        service: "Droplets",
        region: "sgp1",
        resourceId: "123456",
        resourceName: "worker-01",
        amount: 42.5,
        usageQuantity: 120,
        usageUnit: "Hrs",
        startDate: "2026-02-01T00:00:00Z",
        endDate: "2026-02-05T23:59:59Z",
      },
      {
        service: "Spaces Subscription",
        region: undefined,
        resourceId: undefined,
        resourceName: "Spaces ($5/mo 250GiB storage & 1TiB bandwidth)",
        amount: 5,
        usageQuantity: 1,
        usageUnit: "Month",
        startDate: "2026-02-01T00:00:00Z",
        endDate: "2026-03-01T00:00:00Z",
      },
    ]);
  });

  it("aggregates duplicate invoice lines that share the persisted identity", async () => {
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          invoices: [
            {
              invoice_uuid: "inv-feb",
              invoice_period: "2026-02",
              amount: "2577.88",
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          invoice_items: [
            {
              product: "Droplets",
              region: "sgp1",
              resource_uuid: "123456",
              description: "worker-01",
              amount: "42.50",
              duration: "120",
              duration_unit: "Hrs",
              start_time: "2026-02-01T00:00:00Z",
              end_time: "2026-02-05T23:59:59Z",
            },
            {
              product: "Droplets",
              region: "sgp1",
              resource_uuid: "123456",
              description: "worker-01",
              amount: "7.50",
              duration: "24",
              duration_unit: "Hrs",
              start_time: "2026-02-06T00:00:00Z",
              end_time: "2026-02-06T23:59:59Z",
            },
          ],
        })
      );

    const items = await provider.fetchBillItems("2026-02");

    expect(items).toEqual([
      {
        service: "Droplets",
        region: "sgp1",
        resourceId: "123456",
        resourceName: "worker-01",
        amount: 50,
        usageQuantity: 144,
        usageUnit: "Hrs",
        startDate: "2026-02-01T00:00:00Z",
        endDate: "2026-02-06T23:59:59Z",
      },
    ]);
  });

  it("keeps usageQuantity undefined when duplicate invoice lines have no durations", async () => {
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse({
          invoices: [
            {
              invoice_uuid: "inv-feb",
              invoice_period: "2026-02",
              amount: "2577.88",
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        createJsonResponse({
          invoice_items: [
            {
              product: "Load Balancers",
              region: "sgp1",
              resource_uuid: "lb-123",
              description: "public-lb",
              amount: "10.00",
              duration: "",
              duration_unit: "Hour",
              start_time: "2026-02-01T00:00:00Z",
              end_time: "2026-02-14T23:59:59Z",
            },
            {
              product: "Load Balancers",
              region: "sgp1",
              resource_uuid: "lb-123",
              description: "public-lb",
              amount: "10.00",
              duration_unit: "Hour",
              start_time: "2026-02-15T00:00:00Z",
              end_time: "2026-02-28T23:59:59Z",
            },
          ],
        })
      );

    const items = await provider.fetchBillItems("2026-02");

    expect(items).toEqual([
      {
        service: "Load Balancers",
        region: "sgp1",
        resourceId: "lb-123",
        resourceName: "public-lb",
        amount: 20,
        usageQuantity: undefined,
        usageUnit: "Hour",
        startDate: "2026-02-01T00:00:00Z",
        endDate: "2026-02-28T23:59:59Z",
      },
    ]);
  });

  it("returns an empty array for the current month when no matching invoice exists", async () => {
    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        invoices: [
          {
            invoice_uuid: "inv-feb",
            invoice_period: "2026-02",
            amount: "2577.88",
          },
        ],
      })
    );

    const items = await provider.fetchBillItems("2026-03");

    expect(items).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe("fetchBandwidthMetrics", () => {
    // Bandwidth tests use real timers since delay() calls would hang with fake timers
    beforeEach(() => {
      vi.useRealTimers();
    });

    it("fetches bandwidth for all droplets and aggregates into daily GiB", async () => {
      // 1. Droplet list (1 droplet)
      fetchMock.mockResolvedValueOnce(
        createJsonResponse({
          droplets: [{ id: 111, region: { slug: "sgp1" } }],
          meta: { total: 1 },
        })
      );

      // 2. public/inbound — 2 samples at 100 Mbps each (5 min intervals)
      fetchMock.mockResolvedValueOnce(
        createJsonResponse({
          status: "success",
          data: {
            resultType: "matrix",
            result: [
              {
                metric: { host_id: "111" },
                values: [
                  [1711929600, "100"], // 2024-04-01T00:00:00Z
                  [1711929900, "100"], // 2024-04-01T00:05:00Z
                ],
              },
            ],
          },
        })
      );

      // 3. public/outbound — 2 samples at 200 Mbps
      fetchMock.mockResolvedValueOnce(
        createJsonResponse({
          status: "success",
          data: {
            resultType: "matrix",
            result: [
              {
                metric: { host_id: "111" },
                values: [
                  [1711929600, "200"],
                  [1711929900, "200"],
                ],
              },
            ],
          },
        })
      );

      // 4. private/inbound — empty
      fetchMock.mockResolvedValueOnce(
        createJsonResponse({ status: "success", data: { result: [] } })
      );

      // 5. private/outbound — empty
      fetchMock.mockResolvedValueOnce(
        createJsonResponse({ status: "success", data: { result: [] } })
      );

      const metrics = await provider.fetchBandwidthMetrics(
        new Date("2024-04-01T00:00:00Z"),
        new Date("2024-04-01T01:00:00Z")
      );

      expect(metrics).toHaveLength(1);
      expect(metrics[0].resourceId).toBe("111");
      expect(metrics[0].region).toBe("sgp1");
      expect(metrics[0].date).toBe("2024-04-01");
      // 100 Mbps × 300s / 8 / 1024 ≈ 0.03662 GiB per sample, × 2 samples
      expect(metrics[0].publicInGib).toBeCloseTo(2 * 100 * 300 / 8 / 1024, 4);
      expect(metrics[0].publicOutGib).toBeCloseTo(2 * 200 * 300 / 8 / 1024, 4);
      expect(metrics[0].privateInGib).toBe(0);
      expect(metrics[0].privateOutGib).toBe(0);
    });

    it("returns empty array when no droplets exist", async () => {
      fetchMock.mockResolvedValueOnce(
        createJsonResponse({ droplets: [], meta: { total: 0 } })
      );

      const metrics = await provider.fetchBandwidthMetrics(
        new Date("2024-04-01"),
        new Date("2024-04-02")
      );

      expect(metrics).toEqual([]);
    });

    it("handles API errors gracefully and continues", async () => {
      fetchMock
        .mockResolvedValueOnce(
          createJsonResponse({
            droplets: [{ id: 222, region: { slug: "nyc1" } }],
            meta: { total: 1 },
          })
        )
        // All 4 metric calls fail
        .mockResolvedValueOnce(new Response("", { status: 500 }))
        .mockResolvedValueOnce(new Response("", { status: 500 }))
        .mockResolvedValueOnce(new Response("", { status: 500 }))
        .mockResolvedValueOnce(new Response("", { status: 500 }));

      const metrics = await provider.fetchBandwidthMetrics(
        new Date("2024-04-01"),
        new Date("2024-04-02")
      );

      // No data but no crash
      expect(metrics).toEqual([]);
    });
  });
});

describe("aggregateMbpsToDailyGib", () => {
  it("groups samples by UTC date and converts Mbps to GiB", () => {
    const values: [number, string][] = [
      [1711929600, "100"], // 2024-04-01T00:00:00Z
      [1711929900, "200"], // 2024-04-01T00:05:00Z
      [1712016000, "50"],  // 2024-04-02T00:00:00Z
    ];

    const result = aggregateMbpsToDailyGib(values);

    expect(Object.keys(result)).toEqual(["2024-04-01", "2024-04-02"]);
    // Day 1: (100 + 200) × 300 / 8 / 1024
    expect(result["2024-04-01"]).toBeCloseTo(300 * 300 / 8 / 1024, 4);
    // Day 2: 50 × 300 / 8 / 1024
    expect(result["2024-04-02"]).toBeCloseTo(50 * 300 / 8 / 1024, 4);
  });

  it("ignores invalid values (NaN, negative)", () => {
    const values: [number, string][] = [
      [1711929600, "NaN"],
      [1711929900, "-5"],
      [1712016000, "100"],
    ];

    const result = aggregateMbpsToDailyGib(values);
    expect(Object.keys(result)).toEqual(["2024-04-02"]);
  });

  it("returns empty object for empty input", () => {
    expect(aggregateMbpsToDailyGib([])).toEqual({});
  });
});
