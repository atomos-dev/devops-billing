/**
 * S3 Discoverer — discovers Amazon S3 buckets globally.
 * S3 is a global service so ListBuckets is called once (not per-region).
 * For each bucket, GetBucketLocation resolves the hosting region
 * (null / empty string defaults to "us-east-1").
 */
import {
  S3Client,
  ListBucketsCommand,
  GetBucketLocationCommand,
} from "@aws-sdk/client-s3";
import type {
  ResourceDiscoverer,
  DiscoveredResource,
  ProviderCredentials,
} from "../types";

export class S3Discoverer implements ResourceDiscoverer {
  readonly serviceKey = "s3";
  readonly provider = "aws" as const;
  readonly billingServiceNames = ["Amazon Simple Storage Service"];

  async discover(
    credentials: ProviderCredentials,
  ): Promise<DiscoveredResource[]> {
    if (credentials.provider !== "aws") return [];

    const client = new S3Client({
      region: credentials.region,
      credentials: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
      },
    });

    const result = await client.send(new ListBucketsCommand({}));
    const resources: DiscoveredResource[] = [];

    for (const bucket of result.Buckets ?? []) {
      const bucketName = bucket.Name ?? "";

      // Resolve the bucket's hosting region; fall back on error
      let region = "unknown";
      try {
        const locResult = await client.send(
          new GetBucketLocationCommand({ Bucket: bucketName }),
        );
        // AWS returns null/empty for us-east-1 (legacy behaviour)
        region = locResult.LocationConstraint || "us-east-1";
      } catch {
        /* GetBucketLocation can fail for restricted buckets */
      }

      resources.push({
        provider: "aws",
        resourceId: bucketName,
        resourceName: bucketName,
        resourceType: "s3",
        region,
        spec: null,
        tags: {},
        status: "active",
        monthlyBaseCost: null,
      });
    }

    return resources;
  }
}
