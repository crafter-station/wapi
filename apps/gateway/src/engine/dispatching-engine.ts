/**
 * Routes each session to the engine that owns it.
 *
 * This *implements* `WhatsAppEngine` rather than sitting beside it, which is what keeps the
 * change small: `resume.ts`, the RPC server and every downstream consumer already type against
 * the port, so they are untouched. From outside, there is one engine.
 *
 * ## The failure mode this is built around
 *
 * Two things can go wrong, and they are not equally bad. A sandbox session reaching Baileys
 * fails loudly — there are no credentials, so nothing happens quietly. A **real session routed
 * to the fake does not**: the caller gets a `msgId`, the dashboard says sent, the audit log
 * agrees, and no message ever leaves the building.
 *
 * So routing is not left to a single `if`. This dispatcher decides, and then *each engine
 * asserts its own precondition* — the fake refuses a session that is not marked sandbox, and the
 * Baileys path refuses one that is. One `if` is exactly the kind of thing a later refactor
 * inverts; a precondition on both sides turns that into a loud error instead of silent data loss.
 *
 * ## Why the flag is read from the database every time
 *
 * A cache would be faster and wrong: the routing decision must reflect the row, not a snapshot
 * of it from before a restart. The reads are indexed primary-key lookups on a table already in
 * the connection pool's working set, and every alternative trades correctness for a saving
 * nobody has measured a need for.
 */
import type { Logger } from "pino";
import { eq } from "drizzle-orm";
import { whatsappSessions, type Db } from "@wapi/db";
import type {
  ContactRecord,
  EngineEvent,
  EngineIdentity,
  GroupRecord,
  SendContent,
  SendOptions,
  SendResult,
  SessionStatus,
  WhatsAppEngine,
} from "@wapi/core";
import type { SandboxEngine } from "./sandbox-engine.js";

export class DispatchingEngine implements WhatsAppEngine {
  /**
   * Which sessions are sandbox, as last read.
   *
   * Not a cache in the load-bearing sense — every routing decision that can afford a round trip
   * takes one. This exists for the synchronous methods (`status`, `currentQr`, `identity`) which
   * the port defines as non-async and therefore cannot query. They are populated on `connect`,
   * which is the only way a session becomes live in either engine.
   */
  private readonly known = new Map<number, boolean>();

  constructor(
    private readonly db: Db,
    private readonly real: WhatsAppEngine,
    private readonly sandbox: SandboxEngine,
    private readonly logger: Logger,
  ) {}

  /** Both engines feed the same handler, so events are indistinguishable downstream. */
  on(handler: (e: EngineEvent) => void) {
    this.real.on(handler);
    this.sandbox.on(handler);
  }

  private async isSandbox(sessionId: number): Promise<boolean> {
    const [row] = await this.db
      .select({ sandbox: whatsappSessions.sandbox })
      .from(whatsappSessions)
      .where(eq(whatsappSessions.id, sessionId))
      .limit(1);
    const flag = row?.sandbox ?? false;
    this.known.set(sessionId, flag);
    return flag;
  }

  /** For the port's synchronous methods, which cannot await a lookup. */
  private isSandboxSync(sessionId: number): boolean {
    return this.known.get(sessionId) ?? false;
  }

  private async pick(sessionId: number): Promise<WhatsAppEngine> {
    return (await this.isSandbox(sessionId)) ? this.sandbox : this.real;
  }

  // ------------------------------------------------------------------ lifecycle
  async connect(sessionId: number, opts?: { accountProtection?: boolean }) {
    const sandbox = await this.isSandbox(sessionId);
    this.logger.info({ sandbox, sessionId }, "connect");
    return sandbox ? this.sandbox.connect(sessionId, opts) : this.real.connect(sessionId, opts);
  }

  async disconnect(sessionId: number) {
    return (await this.pick(sessionId)).disconnect(sessionId);
  }

  async restart(sessionId: number) {
    return (await this.pick(sessionId)).restart(sessionId);
  }

  async logout(sessionId: number) {
    return (await this.pick(sessionId)).logout(sessionId);
  }

  status(sessionId: number): SessionStatus {
    return this.isSandboxSync(sessionId)
      ? this.sandbox.status(sessionId)
      : this.real.status(sessionId);
  }

  currentQr(sessionId: number): string | null {
    return this.isSandboxSync(sessionId)
      ? this.sandbox.currentQr(sessionId)
      : this.real.currentQr(sessionId);
  }

  identity(sessionId: number): EngineIdentity | null {
    return this.isSandboxSync(sessionId)
      ? this.sandbox.identity(sessionId)
      : this.real.identity(sessionId);
  }

  // -------------------------------------------------------------------- sending
  async sendText(sessionId: number, to: string, text: string, opts?: SendOptions) {
    return (await this.pick(sessionId)).sendText(sessionId, to, text, opts);
  }

  async send(
    sessionId: number,
    to: string,
    content: SendContent,
    opts?: SendOptions,
  ): Promise<SendResult> {
    return (await this.pick(sessionId)).send(sessionId, to, content, opts);
  }

  async reactToMessage(sessionId: number, key: Record<string, unknown>, emoji: string) {
    return (await this.pick(sessionId)).reactToMessage(sessionId, key, emoji);
  }

  async readMessages(sessionId: number, keys: Record<string, unknown>[]) {
    return (await this.pick(sessionId)).readMessages(sessionId, keys);
  }

  async downloadMedia(sessionId: number, message: Record<string, unknown>) {
    return (await this.pick(sessionId)).downloadMedia(sessionId, message);
  }

  // ------------------------------------------------------------------ directory
  async onWhatsApp(sessionId: number, identifier: string) {
    return (await this.pick(sessionId)).onWhatsApp(sessionId, identifier);
  }

  async contacts(sessionId: number): Promise<ContactRecord[]> {
    return (await this.pick(sessionId)).contacts(sessionId);
  }

  async syncContacts(sessionId: number) {
    return (await this.pick(sessionId)).syncContacts(sessionId);
  }

  async contact(sessionId: number, jid: string) {
    return (await this.pick(sessionId)).contact(sessionId, jid);
  }

  async lidFromPn(sessionId: number, pn: string) {
    return (await this.pick(sessionId)).lidFromPn(sessionId, pn);
  }

  async pnFromLid(sessionId: number, lid: string) {
    return (await this.pick(sessionId)).pnFromLid(sessionId, lid);
  }

  async groups(sessionId: number): Promise<GroupRecord[]> {
    return (await this.pick(sessionId)).groups(sessionId);
  }

  async groupMetadata(sessionId: number, jid: string) {
    return (await this.pick(sessionId)).groupMetadata(sessionId, jid);
  }

  async createGroup(sessionId: number, subject: string, participants: string[]) {
    return (await this.pick(sessionId)).createGroup(sessionId, subject, participants);
  }

  async updateParticipants(
    sessionId: number,
    jid: string,
    participants: string[],
    action: "add" | "remove" | "promote" | "demote",
  ) {
    return (await this.pick(sessionId)).updateParticipants(sessionId, jid, participants, action);
  }

  // ------------------------------------------------------- sandbox-only controls
  /**
   * Reached by the sandbox RPC routes. Refuses a session that is not marked sandbox, so a
   * mis-addressed control cannot poke a real session.
   */
  async sandboxInbound(sessionId: number, from: string | undefined, text: string) {
    if (!(await this.isSandbox(sessionId))) {
      throw new Error(`session ${sessionId} is not a sandbox session`);
    }
    return this.sandbox.inbound(sessionId, from, text);
  }

  async sandboxScan(sessionId: number) {
    if (!(await this.isSandbox(sessionId))) {
      throw new Error(`session ${sessionId} is not a sandbox session`);
    }
    this.sandbox.scan(sessionId);
  }
}
