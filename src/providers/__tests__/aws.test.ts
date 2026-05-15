/**
 * Unit tests for src/providers/aws.ts — AwsProvider
 *
 * Covers:
 * - fetchBills(): date formatting, monthly iteration, paginated results, error handling
 * - fetchBillItems(): grouped-by-service, grouped-by-service+region, and resource-level fallback flows
 * - fetchResources(): multi-region EC2 scanning, pagination, tag parsing
 * - testConnection(): success and failure paths
 *
 * All AWS SDK clients are mocked via vi.mock so no real API calls are made.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// AWS SDK mocks — must be declared before the import of AwsProvider
// ---------------------------------------------------------------------------
const mockCeSend = vi.fn();
const mockEc2Send = vi.fn();

vi.mock("@aws-sdk/client-cost-explorer", () => {
  const CostExplorerClient = vi.fn(function (this: Record<string, unknown>) {
    this.send = mockCeSend;
  });
  const GetCostAndUsageCommand = vi.fn(function (this: Record<string, unknown>, input: unknown) {
    this._type = "GetCostAndUsageCommand";
    this.input = input;
  });
  const GetCostAndUsageWithResourcesCommand = vi.fn(function (
    this: Record<string, unknown>,
    input: unknown
  ) {
    this._type = "GetCostAndUsageWithResourcesCommand";
    this.input = input;
  });
  return { CostExplorerClient, GetCostAndUsageCommand, GetCostAndUsageWithResourcesCommand };
});

vi.mock("@aws-sdk/client-ec2", () => {
  const EC2Client = vi.fn(function (this: Record<string, unknown>) {
    this.send = mockEc2Send;
  });
  const DescribeInstancesCommand = vi.fn(function (this: Record<string, unknown>, input: unknown) {
    this._type = "DescribeInstancesCommand";
    this.input = input;
  });
  return { EC2Client, DescribeInstancesCommand };
});

import { AwsProvider } from "../aws";
import { CostExplorerClient } from "@aws-sdk/client-cost-explorer";
import { EC2Client } from "@aws-sdk/client-ec2";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default config used across most tests */
function defaultConfig() {
  return {
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI",
    region: "us-east-1",
    resourceRegions: ["us-east-1"],
  };
}

const AWS_EC2_COMPUTE_SERVICE = "Amazon Elastic Compute Cloud - Compute";

/** Build a Cost Explorer response with a single time period total */
function makeCeResponse(amount: string, nextToken?: string) {
  return {
    ResultsByTime: [
      {
        TimePeriod: { Start: "2024-01-01", End: "2024-02-01" },
        Total: {
          UnblendedCost: { Amount: amount, Unit: "USD" },
        },
        Groups: [],
      },
    ],
    NextPageToken: nextToken,
  };
}

/** Build a Cost Explorer response with grouped results */
function makeCeGroupedResponse(
  groups: { keys: string[]; amount: string }[],
  nextToken?: string,
) {
  return {
    ResultsByTime: [
      {
        TimePeriod: { Start: "2024-01-01", End: "2024-02-01" },
        Groups: groups.map((g) => ({
          Keys: g.keys,
          Metrics: {
            UnblendedCost: { Amount: g.amount, Unit: "USD" },
          },
        })),
      },
    ],
    NextPageToken: nextToken,
  };
}

/** Build an EC2 DescribeInstances response */
function makeEc2Response(
  instances: {
    id: string;
    type: string;
    state: string;
    tags?: Record<string, string>;
  }[],
  nextToken?: string,
) {
  return {
    Reservations: [
      {
        Instances: instances.map((i) => ({
          InstanceId: i.id,
          InstanceType: i.type,
          State: { Name: i.state },
          Tags: Object.entries(i.tags || {}).map(([Key, Value]) => ({
            Key,
            Value,
          })),
        })),
      },
    ],
    NextToken: nextToken,
  };
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("AwsProvider", () => {
  let provider: AwsProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCeSend.mockReset();
    mockEc2Send.mockReset();
    provider = new AwsProvider(defaultConfig());
  });

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------
  describe("constructor", () => {
    it("creates a CostExplorerClient with the provided credentials and region", () => {
      expect(CostExplorerClient).toHaveBeenCalledWith({
        region: "us-east-1",
        credentials: {
          accessKeyId: "AKIAEXAMPLE",
          secretAccessKey: "wJalrXUtnFEMI",
        },
      });
    });

    it('exposes name "aws" and displayName "Amazon Web Services"', () => {
      expect(provider.name).toBe("aws");
      expect(provider.displayName).toBe("Amazon Web Services");
    });
  });

  // -----------------------------------------------------------------------
  // testConnection()
  // -----------------------------------------------------------------------
  describe("testConnection", () => {
    it("returns true when Cost Explorer responds successfully", async () => {
      mockCeSend.mockResolvedValueOnce(makeCeResponse("0"));

      const result = await provider.testConnection();

      expect(result).toBe(true);
      expect(mockCeSend).toHaveBeenCalledTimes(1);
    });

    it("returns false when Cost Explorer throws an error", async () => {
      mockCeSend.mockRejectedValueOnce(new Error("AccessDenied"));

      const result = await provider.testConnection();

      expect(result).toBe(false);
    });

    it("uses DAILY granularity with a single-day time period", async () => {
      mockCeSend.mockResolvedValueOnce(makeCeResponse("0"));

      await provider.testConnection();

      // Inspect the command input passed to send()
      const command = mockCeSend.mock.calls[0][0];
      expect(command.input.Granularity).toBe("DAILY");
      expect(command.input.Metrics).toEqual(["UnblendedCost"]);
    });
  });

  // -----------------------------------------------------------------------
  // fetchBills()
  // -----------------------------------------------------------------------
  describe("fetchBills", () => {
    it("returns one bill per month in the date range", async () => {
      // Jan 2024 and Feb 2024
      mockCeSend
        .mockResolvedValueOnce(makeCeResponse("123.45"))
        .mockResolvedValueOnce(makeCeResponse("678.90"));

      const start = new Date(2024, 0, 15); // Jan 15
      const end = new Date(2024, 1, 20); // Feb 20
      const bills = await provider.fetchBills(start, end);

      expect(bills).toHaveLength(2);

      expect(bills[0].provider).toBe("aws");
      expect(bills[0].billingPeriod).toBe("2024-01");
      expect(bills[0].totalAmount).toBeCloseTo(123.45);

      expect(bills[1].billingPeriod).toBe("2024-02");
      expect(bills[1].totalAmount).toBeCloseTo(678.9);
    });

    it("formats dates as YYYY-MM-DD for the Cost Explorer time period", async () => {
      mockCeSend.mockResolvedValueOnce(makeCeResponse("50"));

      const start = new Date(2024, 2, 10); // March
      const end = new Date(2024, 2, 20);
      await provider.fetchBills(start, end);

      const command = mockCeSend.mock.calls[0][0];
      // March: Start=2024-03-01, End=2024-04-01
      expect(command.input.TimePeriod.Start).toBe("2024-03-01");
      expect(command.input.TimePeriod.End).toBe("2024-04-01");
    });

    it("includes rawData as serialized JSON of the first ResultsByTime entry", async () => {
      const ceResponse = makeCeResponse("99.99");
      mockCeSend.mockResolvedValueOnce(ceResponse);

      const bills = await provider.fetchBills(
        new Date(2024, 0, 1),
        new Date(2024, 0, 31),
      );

      expect(bills[0].rawData).toBe(
        JSON.stringify(ceResponse.ResultsByTime![0]),
      );
    });

    it("handles a single month range correctly", async () => {
      mockCeSend.mockResolvedValueOnce(makeCeResponse("10"));

      const bills = await provider.fetchBills(
        new Date(2024, 5, 1), // June 1
        new Date(2024, 5, 30), // June 30
      );

      expect(bills).toHaveLength(1);
      expect(bills[0].billingPeriod).toBe("2024-06");
    });

    it("defaults totalAmount to 0 when Amount is missing", async () => {
      mockCeSend.mockResolvedValueOnce({
        ResultsByTime: [
          {
            TimePeriod: { Start: "2024-01-01", End: "2024-02-01" },
            Total: {},
          },
        ],
      });

      const bills = await provider.fetchBills(
        new Date(2024, 0, 1),
        new Date(2024, 0, 31),
      );

      expect(bills[0].totalAmount).toBe(0);
    });

    it("continues to next month when one month's API call fails", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      mockCeSend
        .mockRejectedValueOnce(new Error("Throttled"))
        .mockResolvedValueOnce(makeCeResponse("200"));

      const bills = await provider.fetchBills(
        new Date(2024, 0, 1),
        new Date(2024, 1, 28),
      );

      // Should still include the second month
      expect(bills).toHaveLength(1);
      expect(bills[0].billingPeriod).toBe("2024-02");
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // fetchBillItems()
  // -----------------------------------------------------------------------
  describe("fetchBillItems", () => {
    it("returns service+region level items when region data is available", async () => {
      // First call: by SERVICE only
      mockCeSend.mockResolvedValueOnce(
        makeCeGroupedResponse([
          { keys: ["Amazon EC2"], amount: "100" },
          { keys: ["Amazon S3"], amount: "25" },
        ]),
      );

      // Second call: by SERVICE + REGION
      mockCeSend.mockResolvedValueOnce(
        makeCeGroupedResponse([
          { keys: ["Amazon EC2", "us-east-1"], amount: "80" },
          { keys: ["Amazon EC2", "eu-west-1"], amount: "20" },
          { keys: ["Amazon S3", "us-east-1"], amount: "25" },
        ]),
      );
      mockCeSend.mockResolvedValueOnce(makeCeGroupedResponse([]));

      const items = await provider.fetchBillItems("2024-01");

      // The service-only items are replaced by service+region items
      expect(items).toHaveLength(3);
      expect(items[0]).toMatchObject({
        service: "Amazon EC2",
        region: "us-east-1",
        amount: 80,
      });
      expect(items[1]).toMatchObject({
        service: "Amazon EC2",
        region: "eu-west-1",
        amount: 20,
      });
      expect(items[2]).toMatchObject({
        service: "Amazon S3",
        region: "us-east-1",
        amount: 25,
      });
    });

    it("falls back to service-only items when region grouping returns empty", async () => {
      // By SERVICE
      mockCeSend.mockResolvedValueOnce(
        makeCeGroupedResponse([
          { keys: ["Amazon EC2"], amount: "100" },
        ]),
      );

      // By SERVICE + REGION — empty
      mockCeSend.mockResolvedValueOnce(
        makeCeGroupedResponse([]),
      );
      mockCeSend.mockResolvedValueOnce(makeCeGroupedResponse([]));

      const items = await provider.fetchBillItems("2024-03");

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        service: "Amazon EC2",
        amount: 100,
        usageUnit: "USD",
      });
    });

    it("filters out zero-amount items", async () => {
      mockCeSend.mockResolvedValueOnce(
        makeCeGroupedResponse([
          { keys: ["Amazon EC2"], amount: "50" },
          { keys: ["Amazon CloudWatch"], amount: "0" },
        ]),
      );

      // Region grouping returns empty so service-only is used
      mockCeSend.mockResolvedValueOnce(makeCeGroupedResponse([]));
      mockCeSend.mockResolvedValueOnce(makeCeGroupedResponse([]));

      const items = await provider.fetchBillItems("2024-01");

      expect(items).toHaveLength(1);
      expect(items[0].service).toBe("Amazon EC2");
    });

    it("parses billingPeriod string into correct date range", async () => {
      mockCeSend
        .mockResolvedValueOnce(makeCeGroupedResponse([]))
        .mockResolvedValueOnce(makeCeGroupedResponse([]));

      await provider.fetchBillItems("2024-12");

      // First call is for service grouping
      const command = mockCeSend.mock.calls[0][0];
      expect(command.input.TimePeriod.Start).toBe("2024-12-01");
      expect(command.input.TimePeriod.End).toBe("2025-01-01");
    });

    it("handles paginated Cost Explorer results via NextPageToken", async () => {
      // First call for service grouping: page 1 with token, page 2 without
      mockCeSend
        .mockResolvedValueOnce(
          makeCeGroupedResponse(
            [{ keys: ["Amazon EC2"], amount: "50" }],
            "page2-token",
          ),
        )
        .mockResolvedValueOnce(
          makeCeGroupedResponse([{ keys: ["Amazon S3"], amount: "30" }]),
        )
        // Second call for service+region grouping: returns empty
        .mockResolvedValueOnce(makeCeGroupedResponse([]))
        .mockResolvedValueOnce(makeCeGroupedResponse([]));

      const items = await provider.fetchBillItems("2024-06");

      // Both pages from service grouping should be collected
      expect(items).toHaveLength(2);
      expect(items.map((i) => i.service)).toContain("Amazon EC2");
      expect(items.map((i) => i.service)).toContain("Amazon S3");
    });

    it('uses "Unknown" for missing service key and "global" for missing region', async () => {
      // Service grouping
      mockCeSend.mockResolvedValueOnce(makeCeGroupedResponse([]));

      // Service+region grouping with missing keys
      mockCeSend.mockResolvedValueOnce({
        ResultsByTime: [
          {
            Groups: [
              {
                Keys: [],
                Metrics: { UnblendedCost: { Amount: "10", Unit: "USD" } },
              },
            ],
          },
        ],
      });
      mockCeSend.mockResolvedValueOnce(makeCeGroupedResponse([]));

      const items = await provider.fetchBillItems("2024-01");

      expect(items).toHaveLength(1);
      expect(items[0].service).toBe("Unknown");
      expect(items[0].region).toBe("global");
    });

    it("replaces aggregated EC2 compute rows when resource-level coverage is sufficient", async () => {
      mockCeSend.mockResolvedValueOnce(
        makeCeGroupedResponse([
          { keys: [AWS_EC2_COMPUTE_SERVICE], amount: "100" },
          { keys: ["Amazon S3"], amount: "20" },
        ])
      );
      mockCeSend.mockResolvedValueOnce(
        makeCeGroupedResponse([
          { keys: [AWS_EC2_COMPUTE_SERVICE, "us-east-1"], amount: "100" },
          { keys: ["Amazon S3", "us-east-1"], amount: "20" },
        ])
      );
      mockCeSend.mockResolvedValueOnce(
        makeCeGroupedResponse([
          { keys: ["i-abc123", "us-east-1"], amount: "75" },
          { keys: ["i-def456", "us-east-1"], amount: "25" },
        ])
      );

      const items = await provider.fetchBillItems("2024-01");

      expect(items).toHaveLength(3);
      expect(items.filter((item) => item.service === AWS_EC2_COMPUTE_SERVICE)).toEqual([
        expect.objectContaining({
          service: AWS_EC2_COMPUTE_SERVICE,
          region: "us-east-1",
          resourceId: "i-abc123",
          amount: 75,
        }),
        expect.objectContaining({
          service: AWS_EC2_COMPUTE_SERVICE,
          region: "us-east-1",
          resourceId: "i-def456",
          amount: 25,
        }),
      ]);
      expect(items).toContainEqual(
        expect.objectContaining({
          service: "Amazon S3",
          region: "us-east-1",
          amount: 20,
        })
      );
    });

    it("keeps aggregated EC2 compute rows when resource-level coverage is insufficient", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      mockCeSend.mockResolvedValueOnce(
        makeCeGroupedResponse([{ keys: [AWS_EC2_COMPUTE_SERVICE], amount: "100" }])
      );
      mockCeSend.mockResolvedValueOnce(
        makeCeGroupedResponse([{ keys: [AWS_EC2_COMPUTE_SERVICE, "us-east-1"], amount: "100" }])
      );
      mockCeSend.mockResolvedValueOnce(
        makeCeGroupedResponse([{ keys: ["i-abc123", "us-east-1"], amount: "40" }])
      );

      const items = await provider.fetchBillItems("2024-01");

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        service: AWS_EC2_COMPUTE_SERVICE,
        region: "us-east-1",
        amount: 100,
      });
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // fetchResources()
  // -----------------------------------------------------------------------
  describe("fetchResources", () => {
    it("scans all configured regions", async () => {
      const multiRegionConfig = {
        ...defaultConfig(),
        resourceRegions: ["us-east-1", "eu-west-1", "ap-southeast-1"],
      };
      const multiProvider = new AwsProvider(multiRegionConfig);

      // Each region returns one instance
      mockEc2Send
        .mockResolvedValueOnce(
          makeEc2Response([
            { id: "i-us1", type: "t3.micro", state: "running" },
          ]),
        )
        .mockResolvedValueOnce(
          makeEc2Response([
            { id: "i-eu1", type: "t3.small", state: "running" },
          ]),
        )
        .mockResolvedValueOnce(
          makeEc2Response([
            { id: "i-ap1", type: "m5.large", state: "stopped" },
          ]),
        );

      const resources = await multiProvider.fetchResources();

      expect(resources).toHaveLength(3);
      expect(resources.map((r) => r.region)).toEqual([
        "us-east-1",
        "eu-west-1",
        "ap-southeast-1",
      ]);

      // Verify an EC2Client was created per region
      expect(EC2Client).toHaveBeenCalledTimes(3);
    });

    it("parses instance metadata correctly", async () => {
      mockEc2Send.mockResolvedValueOnce(
        makeEc2Response([
          {
            id: "i-abc123",
            type: "m5.xlarge",
            state: "running",
            tags: { Name: "web-server", env: "prod" },
          },
        ]),
      );

      const resources = await provider.fetchResources();

      expect(resources).toHaveLength(1);
      expect(resources[0]).toMatchObject({
        provider: "aws",
        resourceId: "i-abc123",
        resourceName: "web-server",
        resourceType: "ec2",
        region: "us-east-1",
        spec: "m5.xlarge",
        status: "running",
        tags: { Name: "web-server", env: "prod" },
      });
    });

    it("handles paginated DescribeInstances results via NextToken", async () => {
      // Page 1 with token
      mockEc2Send.mockResolvedValueOnce(
        makeEc2Response(
          [{ id: "i-page1", type: "t3.micro", state: "running" }],
          "next-page-token",
        ),
      );
      // Page 2 without token
      mockEc2Send.mockResolvedValueOnce(
        makeEc2Response([
          { id: "i-page2", type: "t3.small", state: "stopped" },
        ]),
      );

      const resources = await provider.fetchResources();

      expect(resources).toHaveLength(2);
      expect(resources[0].resourceId).toBe("i-page1");
      expect(resources[1].resourceId).toBe("i-page2");
      expect(mockEc2Send).toHaveBeenCalledTimes(2);
    });

    it("returns empty name when instance has no Name tag", async () => {
      mockEc2Send.mockResolvedValueOnce(
        makeEc2Response([
          { id: "i-noname", type: "t3.nano", state: "running", tags: {} },
        ]),
      );

      const resources = await provider.fetchResources();

      expect(resources[0].resourceName).toBe("");
    });

    it("handles empty reservations and empty instances gracefully", async () => {
      mockEc2Send.mockResolvedValueOnce({
        Reservations: [],
        NextToken: undefined,
      });

      const resources = await provider.fetchResources();

      expect(resources).toHaveLength(0);
    });

    it("handles missing Reservations field (undefined)", async () => {
      mockEc2Send.mockResolvedValueOnce({});

      const resources = await provider.fetchResources();

      expect(resources).toHaveLength(0);
    });

    it("continues with other regions when one region fails", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const multiProvider = new AwsProvider({
        ...defaultConfig(),
        resourceRegions: ["us-east-1", "eu-west-1"],
      });

      // First region fails
      mockEc2Send.mockRejectedValueOnce(new Error("UnauthorizedOperation"));
      // Second region succeeds
      mockEc2Send.mockResolvedValueOnce(
        makeEc2Response([
          { id: "i-eu1", type: "t3.micro", state: "running" },
        ]),
      );

      const resources = await multiProvider.fetchResources();

      expect(resources).toHaveLength(1);
      expect(resources[0].resourceId).toBe("i-eu1");
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it("maps instance state correctly (including unknown fallback)", async () => {
      mockEc2Send.mockResolvedValueOnce({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: "i-nostate",
                InstanceType: "t3.micro",
                State: {},
                Tags: [],
              },
            ],
          },
        ],
        NextToken: undefined,
      });

      const resources = await provider.fetchResources();

      expect(resources[0].status).toBe("unknown");
    });

    it("passes NextToken from previous page to subsequent DescribeInstances call", async () => {
      mockEc2Send
        .mockResolvedValueOnce(
          makeEc2Response(
            [{ id: "i-1", type: "t3.micro", state: "running" }],
            "token-abc",
          ),
        )
        .mockResolvedValueOnce(
          makeEc2Response([
            { id: "i-2", type: "t3.micro", state: "running" },
          ]),
        );

      await provider.fetchResources();

      // Second call should include the NextToken
      const secondCallCommand = mockEc2Send.mock.calls[1][0];
      expect(secondCallCommand.input.NextToken).toBe("token-abc");
    });
  });
});
