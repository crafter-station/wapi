import { createServer, type Server } from "node:net";
import { request } from "node:https";
import { describe, expect, test } from "bun:test";
import { validateProxy } from "@wapi/core";
import { proxyAgentFor } from "./proxy-agent.js";

/**
 * The agent factory, checked against the validator that guards it.
 *
 * These cannot prove traffic actually leaves through a proxy — that needs a proxy. What they can
 * prove is that every URL the API is willing to store produces an agent, and of the right kind,
 * which is the part that would otherwise fail at connect time on somebody's live session.
 */
describe("proxy agents", () => {
  test("socks5 gets a SOCKS agent", () => {
    const agent = proxyAgentFor("socks5://user:pass@proxy.example.com:1080");
    expect(agent.constructor.name).toBe("SocksProxyAgent");
  });

  test("http and https both get a tunnelling agent", () => {
    // The scheme names how we reach the proxy; the destination is always WhatsApp over TLS, so
    // both must CONNECT rather than forward.
    for (const url of ["http://proxy.example.com:8080", "https://proxy.example.com:8443"]) {
      expect(proxyAgentFor(url).constructor.name).toBe("HttpsProxyAgent");
    }
  });

  test("credentials in the URL are carried through", () => {
    const agent = proxyAgentFor("http://alice:secret@proxy.example.com:8080") as unknown as {
      proxy: URL;
    };
    expect(agent.proxy.username).toBe("alice");
    expect(agent.proxy.password).toBe("secret");
  });

  /**
   * The contract between the two halves. If the API accepts a scheme this cannot build, a user
   * saves a proxy successfully and their session fails to connect afterwards — a failure that
   * surfaces far from its cause.
   */
  test("every scheme the API accepts produces an agent", () => {
    for (const url of [
      "http://proxy.example.com:8080",
      "https://proxy.example.com:8443",
      "socks5://proxy.example.com:1080",
    ]) {
      expect(validateProxy(url)).toBeNull();
      expect(() => proxyAgentFor(url)).not.toThrow();
    }
  });

  /**
   * The assertion that matters: traffic actually goes to the proxy, and asks it to tunnel.
   *
   * Everything above checks types and plumbing, which would all pass just as happily if the agent
   * connected straight to WhatsApp. This stands up a socket that records the first line it is
   * sent and confirms it receives `CONNECT <host>:443` — the request a WebSocket to WhatsApp
   * needs the proxy to make on its behalf. No real tunnel is established; the point is proving
   * where the bytes went.
   */
  test("routes through the proxy and asks it to CONNECT", async () => {
    let firstLine = "";
    const proxy: Server = createServer((socket) => {
      socket.once("data", (chunk) => {
        firstLine = chunk.toString().slice(0, 60);
        socket.destroy();
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const { port } = proxy.address() as { port: number };

    const agent = proxyAgentFor(`http://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => {
      const req = request({ agent, host: "web.whatsapp.com", method: "GET", path: "/" }, () => resolve());
      req.on("error", () => resolve()); // the proxy hangs up on purpose
      req.end();
    });

    proxy.close();
    expect(firstLine).toStartWith("CONNECT web.whatsapp.com:443");
  });
});