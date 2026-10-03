import { connect, type Socket } from "net";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * WebSocket-to-TCP bridge for tests.
 *
 * The app hardcodes @neondatabase/serverless, whose Pool speaks the postgres
 * wire protocol over WebSocket only — it cannot reach a stock postgres over
 * TCP (e.g. the CI service container or a local scratch server). This bridge
 * is a transparent byte-pipe: it accepts the driver's WebSocket connections
 * and shuttles raw pg-protocol bytes to/from a TCP postgres. It interprets
 * nothing, so the app, driver, SQL, and database under test are all real.
 *
 * Test infrastructure only. Never imported by application code.
 */
export interface PgBridge {
  /**
   * Host:port for neonConfig.wsProxy. The driver prepends ws:// or wss://
   * itself (from neonConfig.useSecureWebSocket), so this must NOT include
   * a scheme — otherwise the URL becomes ws://ws://... and never connects.
   */
  wsProxyTarget: string;
  close: () => Promise<void>;
}

export async function startPgBridge(pgHost: string, pgPort: number): Promise<PgBridge> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const addr = wss.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;

  wss.on("connection", (ws: WebSocket) => {
    const tcp: Socket = connect(pgPort, pgHost);
    const cleanup = () => {
      try {
        tcp.destroy();
      } catch {
        /* already gone */
      }
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    };
    ws.on("message", (data) => {
      if (!tcp.destroyed) tcp.write(data as Buffer);
    });
    tcp.on("data", (data) => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    });
    ws.on("close", cleanup);
    ws.on("error", cleanup);
    tcp.on("close", cleanup);
    tcp.on("error", cleanup);
  });

  return {
    wsProxyTarget: `127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        wss.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
