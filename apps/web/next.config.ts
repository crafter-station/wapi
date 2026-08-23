import type { NextConfig } from "next";

const config: NextConfig = {
  // Standalone keeps the image small; the workspace packages are traced from the repo root.
  output: "standalone",
  outputFileTracingRoot: "../../",

  /**
   * The shared packages are TypeScript source, not built artifacts, so Next has to compile
   * them itself.
   */
  transpilePackages: ["@wapi/core", "@wapi/db", "@wapi/contracts"],

  /**
   * Built with webpack rather than Turbopack, for one specific reason.
   *
   * The shared packages use NodeNext-style `./thing.js` specifiers that point at `.ts`
   * sources — required because `apps/gateway` and `apps/webhook-worker` run under Node with
   * `moduleResolution: nodenext`. Turbopack cannot map those back to `.ts` and fails with 27
   * "Can't resolve './crypto.js'" errors; webpack can, via `extensionAlias` below.
   *
   * The alternative — dropping extensions from the packages' internal imports — would break
   * the Node consumers, so the bundler bends rather than the runtime.
   */
  webpack: (cfg) => {
    cfg.resolve.extensionAlias = {
      ...(cfg.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return cfg;
  },
};

export default config;
