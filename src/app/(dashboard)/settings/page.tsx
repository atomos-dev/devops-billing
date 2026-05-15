/**
 * Settings page — manage cloud provider connections.
 * Provider cards with credential editing, connection testing, and enable/disable.
 * Forms are dynamically generated from PROVIDER_REGISTRY credential field definitions.
 */
"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Loader2, AlertCircle, Plug } from "lucide-react";

interface CredentialFieldView {
  key: string;
  label: string;
  type: "text" | "password";
  required: boolean;
  hasValue: boolean;
  value?: string;
  default?: string;
  hint?: string;
}

interface ProviderSettingView {
  provider: string;
  displayName: string;
  enabled: boolean;
  configured: boolean;
  configSource: "database" | "env" | "none";
  lastTestedAt: string | null;
  lastTestResult: boolean | null;
  credentialFields: CredentialFieldView[];
}

export default function SettingsPage() {
  const [providers, setProviders] = useState<ProviderSettingView[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const fetchProviders = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/settings/providers");
      if (res.ok) {
        const data = await res.json();
        setProviders(data.providers || []);
      }
    } catch (error) {
      console.error("Failed to fetch settings:", error);
      toast.error("Failed to load provider settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  /** Open the credential edit dialog for a provider */
  const openEditDialog = (provider: ProviderSettingView) => {
    setEditingProvider(provider.provider);
    // Pre-fill text fields with existing values, leave password fields empty
    const values: Record<string, string> = {};
    for (const field of provider.credentialFields) {
      if (field.type !== "password" && field.value) {
        values[field.key] = field.value;
      } else if (field.default && !field.hasValue) {
        values[field.key] = field.default;
      } else {
        values[field.key] = "";
      }
    }
    setFormValues(values);
    setDialogOpen(true);
  };

  /** Save credentials for the currently editing provider */
  const handleSave = async () => {
    if (!editingProvider) return;
    setSaving(true);

    try {
      const res = await fetch(`/api/v1/settings/providers/${editingProvider}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: true,
          credentials: formValues,
        }),
      });

      if (res.ok) {
        toast.success("Credentials saved");
        setDialogOpen(false);
        setEditingProvider(null);
        await fetchProviders();
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to save");
      }
    } catch {
      toast.error("Failed to save credentials");
    } finally {
      setSaving(false);
    }
  };

  /** Test connection for a provider */
  const handleTest = async (providerKey: string) => {
    setTesting(providerKey);
    try {
      const res = await fetch(`/api/v1/settings/providers/${providerKey}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const data = await res.json();
      if (data.success) {
        toast.success(data.message || "Connection successful");
      } else {
        toast.error(data.message || "Connection failed");
      }
      await fetchProviders();
    } catch {
      toast.error("Connection test failed");
    } finally {
      setTesting(null);
    }
  };

  /** Toggle provider enabled/disabled */
  const handleToggle = async (providerKey: string, currentEnabled: boolean) => {
    try {
      const res = await fetch(`/api/v1/settings/providers/${providerKey}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !currentEnabled }),
      });

      if (res.ok) {
        toast.success(`Provider ${!currentEnabled ? "enabled" : "disabled"}`);
        await fetchProviders();
      }
    } catch {
      toast.error("Failed to update provider");
    }
  };

  /** Render status indicator */
  const StatusDot = ({ provider }: { provider: ProviderSettingView }) => {
    if (!provider.configured) {
      return (
        <div className="flex items-center gap-1.5">
          <div className="h-2 w-2 rounded-full bg-muted-foreground/40" />
          <span className="text-xs text-muted-foreground">Not configured</span>
        </div>
      );
    }
    if (provider.lastTestResult === true) {
      return (
        <div className="flex items-center gap-1.5">
          <div className="h-2 w-2 rounded-full bg-accent" />
          <span className="text-xs text-accent">Connected</span>
        </div>
      );
    }
    if (provider.lastTestResult === false) {
      return (
        <div className="flex items-center gap-1.5">
          <div className="h-2 w-2 rounded-full bg-destructive" />
          <span className="text-xs text-destructive">Failed</span>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-1.5">
        <div className="h-2 w-2 rounded-full bg-warning" />
        <span className="text-xs text-muted-foreground">Not tested</span>
      </div>
    );
  };

  /** Format time ago */
  const timeAgo = (isoStr: string | null) => {
    if (!isoStr) return null;
    const diff = Date.now() - new Date(isoStr).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes <= 0) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };

  // Get fields for currently editing provider
  const editingFields = editingProvider
    ? providers.find((p) => p.provider === editingProvider)?.credentialFields || []
    : [];

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage cloud provider connections
        </p>
      </div>

      <div className="space-y-4">
        {providers.map((provider) => (
          <Card key={provider.provider} className="card-shadow">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">{provider.displayName}</CardTitle>
                <div className="flex items-center gap-2">
                  {provider.enabled ? (
                    <Badge className="bg-accent/15 text-accent border-accent/30 hover:bg-accent/15">
                      Enabled
                    </Badge>
                  ) : (
                    <Badge variant="secondary">Disabled</Badge>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Status row */}
              <div className="flex items-center gap-6">
                <StatusDot provider={provider} />
                {provider.configSource !== "none" && (
                  <span className="text-xs text-muted-foreground">
                    Source: {provider.configSource === "database" ? "Database" : "Environment"}
                  </span>
                )}
                {provider.lastTestedAt && (
                  <span className="text-xs text-muted-foreground">
                    Tested {timeAgo(provider.lastTestedAt)}
                  </span>
                )}
              </div>

              {/* Env migration hint */}
              {provider.configSource === "env" && (
                <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  Credentials loaded from environment variables. Edit to save to database.
                </div>
              )}

              {/* Credential summary */}
              {provider.configured && (
                <div className="rounded-md bg-muted/30 px-4 py-3 space-y-1.5">
                  {provider.credentialFields.map((field) => (
                    <div key={field.key} className="flex items-center text-sm">
                      <span className="w-32 text-muted-foreground text-xs">{field.label}</span>
                      <span className="font-mono text-xs">
                        {field.hasValue
                          ? field.type === "password"
                            ? "••••••••"
                            : field.value || "—"
                          : "—"}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Actions */}
              <div className="flex items-center gap-2 pt-1">
                <Dialog open={dialogOpen && editingProvider === provider.provider} onOpenChange={setDialogOpen}>
                  <DialogTrigger render={<Button variant="outline" size="sm" onClick={() => openEditDialog(provider)} />}>
                    {provider.configured ? "Edit Credentials" : "Configure"}
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>{provider.displayName} — Credentials</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-2">
                      {editingFields.map((field) => (
                        <div key={field.key} className="space-y-2">
                          <Label htmlFor={`field-${field.key}`}>
                            {field.label}
                            {field.required && <span className="text-destructive ml-1">*</span>}
                          </Label>
                          <Input
                            id={`field-${field.key}`}
                            type={field.type === "password" ? "password" : "text"}
                            placeholder={
                              field.type === "password" && field.hasValue
                                ? "••••••••  (leave empty to keep current)"
                                : field.default || ""
                            }
                            value={formValues[field.key] || ""}
                            onChange={(e) =>
                              setFormValues((prev) => ({
                                ...prev,
                                [field.key]: e.target.value,
                              }))
                            }
                          />
                          {field.hint && (
                            <p className="text-xs text-muted-foreground">{field.hint}</p>
                          )}
                        </div>
                      ))}
                      <div className="flex justify-end gap-2 pt-2">
                        <Button
                          variant="outline"
                          onClick={() => setDialogOpen(false)}
                        >
                          Cancel
                        </Button>
                        <Button
                          onClick={handleSave}
                          disabled={saving}
                          className="bg-accent hover:bg-accent/90 text-accent-foreground"
                        >
                          {saving ? (
                            <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving...</>
                          ) : (
                            "Save"
                          )}
                        </Button>
                      </div>
                    </div>
                  </DialogContent>
                </Dialog>

                {provider.configured && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleTest(provider.provider)}
                    disabled={testing === provider.provider}
                  >
                    {testing === provider.provider ? (
                      <><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Testing...</>
                    ) : (
                      <><Plug className="mr-1 h-3.5 w-3.5" /> Test Connection</>
                    )}
                  </Button>
                )}

                <div className="flex-1" />

                <Button
                  variant={provider.enabled ? "outline" : "default"}
                  size="sm"
                  onClick={() => handleToggle(provider.provider, provider.enabled)}
                >
                  {provider.enabled ? "Disable" : "Enable"}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
