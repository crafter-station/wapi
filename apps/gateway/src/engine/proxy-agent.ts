// `node:https`, because that is what Baileys' SocketConfig declares. Both agents below are
// http.Agent subclasses at runtime and tunnel via CONNECT either way; the cast is about the type
// declaration, not about behaviour.
import type { Agent } from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

/**
 * Build the outbound agent for a session's `proxy_url`.
 *
 * `proxy_url` was accepted, validated and stored from the beginning, and read by nothing: the
 * socket was built with no agent, so traffic went out directly whatever the field said. A proxy
 * that silently does nothing is worse than one that is refused — the whole reason somebody sets
 * it is that they need the egress IP to be somewhere else, and they have no way to tell it is not
 * working until it matters.
 *
 * Schemes match `validateProxy` in `@wapi/core`, which is what the API enforces: http, https and
 * socks5. Anything else has already been rejected before a row could store it, so reaching the
 * fallback here means the two have drifted apart.
 */
export function proxyAgentFor(proxyUrl: string): Agent {
  const { protocol } = new URL(proxyUrl);
  if (protocol === "socks5:" || protocol === "socks4:" || protocol === "socks:") {
    return new SocksProxyAgent(proxyUrl) as unknown as Agent;
  }
  /**
   * `HttpsProxyAgent` for `http:` proxies too, and that is not a typo: the scheme names how we
   * reach the *proxy*, while the tunnelled destination is always WhatsApp over TLS. An
   * `HttpProxyAgent` here would try to forward absolute-URL requests rather than CONNECT, which
   * a WebSocket cannot use.
   */
  return new HttpsProxyAgent(proxyUrl) as unknown as Agent;
}
