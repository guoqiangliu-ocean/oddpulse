import vinext from "vinext";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig(async ({ command }) => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");
  const localBindingConfig = {
    main: "./worker/index.ts",
    compatibility_flags: ["nodejs_compat"],
    // Local previews read ignored environment files. Production builds leave
    // these values empty so Sites can inject server-only runtime variables.
    vars:
      command === "serve"
        ? {
            TXLINE_API_TOKEN: process.env.TXLINE_API_TOKEN ?? "",
            TXLINE_BASE_URL: process.env.TXLINE_BASE_URL ?? "",
            TXLINE_NETWORK: process.env.TXLINE_NETWORK ?? "",
            TXLINE_SESSION_JWT: process.env.TXLINE_SESSION_JWT ?? "",
            TXLINE_RPC_URL: process.env.TXLINE_RPC_URL ?? "",
            TXLINE_VIEW_PAYER: process.env.TXLINE_VIEW_PAYER ?? "",
          }
        : {},
    d1_databases: d1
      ? [
          {
            binding: d1,
            database_name: "site-creator-d1",
            database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
          },
        ]
      : [],
    r2_buckets: r2
      ? [
          {
            binding: r2,
            bucket_name: "site-creator-r2",
          },
        ]
      : [],
  };

  return {
    resolve: {
      // Anchor's browser ESM build keeps read-only Program/Provider view calls
      // compatible with the Worker runtime without its Node-only loader.
      alias: {
        "@coral-xyz/anchor": fileURLToPath(
          new URL(
            "./node_modules/@coral-xyz/anchor/dist/browser/index.js",
            import.meta.url,
          ),
        ),
      },
    },
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
