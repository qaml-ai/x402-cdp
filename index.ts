/**
 * x402-cdp: Shared helper for creating a CDP-authenticated x402 facilitator + resource server
 * for Cloudflare Workers.
 *
 * In CF Workers, env vars/secrets are only available via c.env (not process.env).
 * This helper defers all env reads to request time.
 *
 * Usage:
 *   import { cdpPaymentMiddleware } from "x402-cdp";
 *   app.use(cdpPaymentMiddleware((env) => routes.paymentConfig(env.SERVER_ADDRESS)));
 *
 * Requires CF Worker env bindings:
 *   - SERVER_ADDRESS (var in wrangler.jsonc)
 *   - CDP_API_KEY_ID, CDP_API_KEY_SECRET (secrets via `wrangler secret put`)
 */

import { HTTPFacilitatorClient } from "@x402/core/server";
import { x402ResourceServer, paymentMiddleware } from "@x402/hono";
import { ExactEvmScheme, registerExactEvmScheme as registerServerEvmScheme } from "@x402/evm/exact/server";
import { registerExactSvmScheme as registerServerSvmScheme } from "@x402/svm/exact/server";

// Patch ExactEvmScheme to add Polygon USDC (not in @x402/evm@2.6.0 defaults)
const origGetDefaultAsset = ExactEvmScheme.prototype["getDefaultAsset"];
ExactEvmScheme.prototype["getDefaultAsset"] = function (network: string) {
  if (network === "eip155:137") {
    return { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", name: "USD Coin", version: "2", decimals: 6 };
  }
  return origGetDefaultAsset.call(this, network);
};
import { generateJwt } from "@coinbase/cdp-sdk/auth";
import type { MiddlewareHandler } from "hono";

const CDP_HOST = "api.cdp.coinbase.com";
const CDP_FACILITATOR_URL = `https://${CDP_HOST}/platform/v2/x402`;

async function makeCdpJwt(
  apiKeyId: string,
  apiKeySecret: string,
  method: string,
  path: string
): Promise<string> {
  return generateJwt({
    apiKeyId,
    apiKeySecret,
    requestMethod: method,
    requestHost: CDP_HOST,
    requestPath: path,
  });
}

type RoutesConfig = Parameters<typeof paymentMiddleware>[0];

/**
 * Creates a payment middleware that uses the CDP facilitator with JWT auth.
 * All env reads (SERVER_ADDRESS, CDP keys) happen at request time via c.env.
 *
 * @param routesFactory - Function that receives c.env and returns routes config.
 *   Example: (env) => routes.paymentConfig(env.SERVER_ADDRESS)
 */
export function cdpPaymentMiddleware(
  routesFactory: (env: Record<string, string>) => RoutesConfig
): MiddlewareHandler {
  // These are initialized lazily on first request
  let cdpKeyId: string | undefined;
  let cdpKeySecret: string | undefined;
  let mw: MiddlewareHandler | null = null;
  let initPromise: Promise<void> | null = null;

  return async (c, next) => {
    // First request: capture env, build everything
    if (!mw) {
      const env = c.env as Record<string, string>;

      cdpKeyId = env.CDP_API_KEY_ID;
      cdpKeySecret = env.CDP_API_KEY_SECRET;
      if (!cdpKeyId || !cdpKeySecret) {
        throw new Error("CDP_API_KEY_ID and CDP_API_KEY_SECRET must be set as Worker secrets");
      }

      const facilitatorClient = new HTTPFacilitatorClient({
        url: CDP_FACILITATOR_URL,
        createAuthHeaders: async () => ({
          verify: {
            Authorization: `Bearer ${await makeCdpJwt(cdpKeyId!, cdpKeySecret!, "POST", "/platform/v2/x402/verify")}`,
          },
          settle: {
            Authorization: `Bearer ${await makeCdpJwt(cdpKeyId!, cdpKeySecret!, "POST", "/platform/v2/x402/settle")}`,
          },
          supported: {
            Authorization: `Bearer ${await makeCdpJwt(cdpKeyId!, cdpKeySecret!, "GET", "/platform/v2/x402/supported")}`,
          },
        }),
      });

      const resourceServer = new x402ResourceServer(facilitatorClient);
      registerServerEvmScheme(resourceServer);
      registerServerSvmScheme(resourceServer);

      const routes = routesFactory(env);
      mw = paymentMiddleware(routes, resourceServer, undefined, undefined, false);
      initPromise = resourceServer.initialize();
    }

    // Wait for facilitator initialization
    try {
      await initPromise;
    } catch (e) {
      // Reset everything so next request retries from scratch
      mw = null;
      initPromise = null;
      cdpKeyId = undefined;
      cdpKeySecret = undefined;
      throw e;
    }

    return mw!(c, next);
  };
}
