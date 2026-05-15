/**
 * Provider registry — defines metadata and credential field schemas for all
 * supported cloud providers. Single source of truth for displayName and
 * credential structure. Settings UI dynamically renders forms from this data.
 */

/** Definition of a single credential field for a provider */
export interface CredentialField {
  key: string;
  label: string;
  type: "text" | "password";
  required: boolean;
  default?: string;
  hint?: string;
}

/** Provider metadata used by Settings UI and config loader */
export interface ProviderMeta {
  displayName: string;
  credentialFields: CredentialField[];
  /**
   * Transform flat credential key-value pairs into the config object
   * expected by the provider's constructor (e.g. split comma-separated strings).
   */
  toProviderConfig: (creds: Record<string, string>) => Record<string, unknown>;
}

/**
 * Registry of all known cloud providers.
 * To add a new provider:
 *   1. Add an entry here with credentialFields and toProviderConfig
 *   2. Write a class implementing BillingProvider
 *   3. Register the factory in PROVIDER_FACTORIES (src/providers/index.ts)
 */
export const PROVIDER_REGISTRY: Record<string, ProviderMeta> = {
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
        hint: "Comma-separated region codes, e.g. us-east-1,ap-southeast-1",
      },
    ],
    toProviderConfig: (creds) => ({
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      region: creds.region || "us-east-1",
      resourceRegions: (creds.resourceRegions || creds.region || "us-east-1")
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean),
    }),
  },
  digitalocean: {
    displayName: "DigitalOcean",
    credentialFields: [
      { key: "apiToken", label: "API Token", type: "password", required: true },
    ],
    toProviderConfig: (creds) => ({
      apiToken: creds.apiToken,
    }),
  },
  "alibaba-cloud": {
    displayName: "Alibaba Cloud",
    credentialFields: [
      { key: "accessKeyId", label: "Access Key ID", type: "text", required: true },
      { key: "accessKeySecret", label: "Access Key Secret", type: "password", required: true },
      {
        key: "site",
        label: "Site",
        type: "text",
        required: false,
        default: "china",
        hint: "china or international",
      },
      {
        key: "regionId",
        label: "Default Region",
        type: "text",
        required: false,
        default: "cn-hangzhou",
        hint: "e.g. cn-hangzhou, ap-southeast-1, us-west-1",
      },
    ],
    toProviderConfig: (creds) => ({
      accessKeyId: creds.accessKeyId,
      accessKeySecret: creds.accessKeySecret,
      site: creds.site || "china",
      regionId: creds.regionId || (creds.site === "international" ? "ap-southeast-1" : "cn-hangzhou"),
    }),
  },
};
