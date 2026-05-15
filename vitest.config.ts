/**
 * Vitest configuration for unit tests.
 * Uses jsdom for React component testing.
 */
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/__tests__/**",
        "src/components/ui/**",
        "src/app/**/layout.tsx",
      ],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Vite's module resolver cannot handle directory names with square brackets
      // (Next.js dynamic route segments). Provide explicit aliases so the
      // settings-routes test can import these handlers without bracket paths.
      "@settings-provider-route": path.resolve(
        __dirname,
        "./src/app/api/v1/settings/providers/[provider]/route.ts"
      ),
      "@settings-provider-test-route": path.resolve(
        __dirname,
        "./src/app/api/v1/settings/providers/[provider]/test/route.ts"
      ),
    },
  },
});
