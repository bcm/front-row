import { createServer, type Server } from "https";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { AddressInfo } from "net";

export interface OidcDiscoveryStub {
  /** Base URL of the stub, e.g. https://127.0.0.1:PORT (no trailing slash). */
  url: string;
  close: () => Promise<void>;
}

/**
 * Minimal local OIDC discovery stub. Serves a static discovery document at
 * /.well-known/openid-configuration (plus an empty /jwks) so that
 * openid-client's discovery() inside setupAuth() never touches the network.
 * Only discovery is stubbed: sessions are still minted directly in the real
 * pg session store, and Passport/isAuthenticated stay fully real.
 *
 * HTTPS (not plain HTTP) is required: openid-client v6 rejects non-HTTPS
 * discovery URLs, and replitAuth.ts passes no allowInsecureRequests option,
 * so the stub serves TLS with a committed test-only self-signed certificate
 * (fixtures/, localhost-only). The harness sets NODE_TLS_REJECT_UNAUTHORIZED
 * for the test process.
 */
export async function startOidcDiscoveryStub(): Promise<OidcDiscoveryStub> {
  const dir = dirname(fileURLToPath(import.meta.url));
  let base = "";
  const server: Server = createServer(
    {
      key: readFileSync(join(dir, "fixtures", "oidc-stub-key.pem")),
      cert: readFileSync(join(dir, "fixtures", "oidc-stub-cert.pem")),
    },
    (req, res) => {
      if (req.url === "/.well-known/openid-configuration") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            // Must equal the discovery URL exactly (trailing slash).
            issuer: `${base}/`,
            authorization_endpoint: `${base}/authorize`,
            token_endpoint: `${base}/token`,
            userinfo_endpoint: `${base}/userinfo`,
            jwks_uri: `${base}/jwks`,
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
          })
        );
      } else if (req.url === "/jwks") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ keys: [] }));
      } else {
        res.writeHead(404).end();
      }
    }
  );

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const { port } = server.address() as AddressInfo;
  base = `https://127.0.0.1:${port}`;

  return {
    url: base,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
}
