import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { basename, dirname, join } from "node:path";

/**
 * KakaoTalk through kakaotalk-bridge (github.com/alpoxdev/kakaotalk-bridge). The bridge's resident receiver
 * (`kakaotalk-bridge --profile <p> --receive --socket <sock>`) owns the account: it stores every received message in its
 * SQLite archive and serves MCP tools on a Unix socket. dori reads the archive directly and sends through the socket.
 *
 * The rule this module enforces, in code rather than in a prompt: an open chat (link_id != 0) may be answered; an
 * ordinary room (link_id == 0), or a room the archive does not know, is read-only. Nothing is sent there and nothing is
 * marked read, so its members never see the Dori.
 */

export type KakaoRoom = { readonly chatId: string; readonly linkId: string; readonly name: string; readonly open: boolean };

export type KakaoMessage = {
  readonly seq: number;
  readonly chatId: string;
  readonly logId: string;
  readonly authorId: string;
  readonly text: string;
  readonly attachment: boolean;
  readonly sentAt: number;
};

export class KakaoReadOnlyRoomError extends Error {}

/** The bridge's archive for one account: `<dataDir>/archive/<profile>/<account id>.sqlite`. */
export const findKakaoArchive = (dataDir: string, profile: string): string => {
  const dir = join(dataDir, "archive", profile);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^\d+\.sqlite$/.test(f)) : [];
  if (files.length !== 1) throw new Error(`expected one account archive in ${dir}, found ${files.length}; log in with kakaotalk-bridge --profile ${profile} cli server-auth login and run its receiver`);
  return join(dir, files[0]!);
};

// SQLite integers past 2^53 (KakaoTalk ids are) must never become JS numbers: every id is read as text.
export class KakaoArchive {
  readonly selfId: string;
  private readonly db: Database;

  /**
   * `openChats` lists the open chats the Dori may answer, by chat id. Empty: every open chat. An open chat not on a
   * non-empty list is treated like an ordinary room: read-only, and it wakes no one.
   */
  constructor(readonly path: string, readonly openChats: readonly string[] = []) {
    // The bridge keeps the archive in WAL mode and removes its -shm file between writes; a readonly connection cannot
    // recreate it and fails to open. Open read-write so SQLite can manage that file, and refuse every write ourselves.
    this.db = new Database(path, { readwrite: true, create: false });
    this.db.run("PRAGMA query_only = 1");
    this.selfId = basename(path, ".sqlite");
  }

  close(): void {
    this.db.close();
  }

  room(chatId: string): KakaoRoom | undefined {
    const row = this.db
      .query<{ chat_id: string; link_id: string; metadata: string }, [string]>(
        "SELECT CAST(chat_id AS TEXT) AS chat_id, CAST(link_id AS TEXT) AS link_id, metadata FROM rooms WHERE chat_id = CAST(?1 AS INTEGER)",
      )
      .get(chatId);
    return row ? this.toRoom(row) : undefined;
  }

  rooms(): KakaoRoom[] {
    return this.db
      .query<{ chat_id: string; link_id: string; metadata: string }, []>(
        "SELECT CAST(chat_id AS TEXT) AS chat_id, CAST(link_id AS TEXT) AS link_id, metadata FROM rooms ORDER BY link_id = 0, chat_id",
      )
      .all()
      .map((row) => this.toRoom(row));
  }

  private toRoom(row: { chat_id: string; link_id: string; metadata: string }): KakaoRoom {
    const room = toRoom(row);
    return room.open && this.openChats.length > 0 && !this.openChats.includes(room.chatId) ? { ...room, open: false } : room;
  }

  lastSeq(): number {
    return this.db.query<{ seq: number | null }, []>("SELECT MAX(seq) AS seq FROM events").get()?.seq ?? 0;
  }

  /** Received messages after `seq`, oldest first, one per MSG event (a message stored without its event is skipped). */
  messagesAfter(seq: number, limit = 200): KakaoMessage[] {
    return this.db
      .query<{ seq: number; chat_id: string; log_id: string; author_id: string; text: string | null; attachment: string | null; sent_at: number }, [number, number]>(
        `SELECT e.seq, CAST(m.chat_id AS TEXT) AS chat_id, CAST(m.log_id AS TEXT) AS log_id, CAST(m.author_id AS TEXT) AS author_id,
                m.text, m.attachment, m.sent_at
           FROM events e JOIN messages m ON m.chat_id = e.chat_id AND m.log_id = e.log_id
          WHERE e.method = 'MSG' AND e.seq > ?1 ORDER BY e.seq LIMIT ?2`,
      )
      .all(seq, limit)
      .map((r) => ({ seq: r.seq, chatId: r.chat_id, logId: r.log_id, authorId: r.author_id, text: r.text ?? "", attachment: Boolean(r.attachment), sentAt: r.sent_at }));
  }

  /** The newest stored messages of one room, oldest first. */
  recent(chatId: string, limit: number): Omit<KakaoMessage, "seq">[] {
    return this.db
      .query<{ chat_id: string; log_id: string; author_id: string; text: string | null; attachment: string | null; sent_at: number }, [string, number]>(
        `SELECT CAST(chat_id AS TEXT) AS chat_id, CAST(log_id AS TEXT) AS log_id, CAST(author_id AS TEXT) AS author_id, text, attachment, sent_at
           FROM messages WHERE chat_id = CAST(?1 AS INTEGER) ORDER BY log_id DESC LIMIT ?2`,
      )
      .all(chatId, limit)
      .reverse()
      .map((r) => ({ chatId: r.chat_id, logId: r.log_id, authorId: r.author_id, text: r.text ?? "", attachment: Boolean(r.attachment), sentAt: r.sent_at }));
  }
}

const toRoom = (row: { chat_id: string; link_id: string; metadata: string }): KakaoRoom => {
  let name = "";
  try {
    const meta = JSON.parse(row.metadata) as { display_name?: unknown; chat_name?: unknown };
    name = String(meta.display_name ?? meta.chat_name ?? "");
  } catch {
    // A room with unreadable metadata keeps its ids; its kind comes from link_id alone.
  }
  return { chatId: row.chat_id, linkId: row.link_id, name, open: row.link_id !== "0" };
};

/** One MCP tool call against the bridge's Unix socket: initialize, call, close. Returns the tool's `data`. */
export type KakaoCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export const bridgeSocket = (socketPath: string, timeoutMs = 120_000): KakaoCall => (tool, args) => {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const sock = connect(socketPath);
  let buf = "";
  const done = (fn: () => void) => {
    clearTimeout(timer);
    sock.destroy();
    fn();
  };
  const timer = setTimeout(() => done(() => reject(new Error(`kakaotalk-bridge ${tool} timed out after ${timeoutMs} ms`))), timeoutMs);
  const write = (m: unknown) => sock.write(`${JSON.stringify(m)}\n`);
  sock.on("error", (e) => done(() => reject(new Error(`kakaotalk-bridge socket ${socketPath}: ${e.message}`))));
  sock.on("connect", () => write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "dori", version: "1" } } }));
  sock.on("data", (chunk) => {
    buf += chunk.toString();
    let at = buf.indexOf("\n");
    while (at >= 0) {
      const line = buf.slice(0, at);
      buf = buf.slice(at + 1);
      at = buf.indexOf("\n");
      let msg: { id?: number; result?: { structuredContent?: unknown; content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id === 1) {
        write({ jsonrpc: "2.0", method: "notifications/initialized" });
        write({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
      } else if (msg.id === 2) {
        if (msg.error) return done(() => reject(new Error(`kakaotalk-bridge ${tool}: ${msg.error?.message ?? "error"}`)));
        let body = msg.result?.structuredContent;
        if (body === undefined) {
          try {
            body = JSON.parse(msg.result?.content?.[0]?.text ?? "null");
          } catch {
            body = msg.result?.content?.[0]?.text;
          }
        }
        const envelope = body as { ok?: boolean; data?: unknown; error?: { code?: string; message?: string } } | null;
        if (msg.result?.isError || envelope?.ok === false) {
          return done(() => reject(new Error(`kakaotalk-bridge ${tool}: ${envelope?.error?.code ?? "error"} ${envelope?.error?.message ?? ""}`.trim())));
        }
        return done(() => resolve(envelope?.data ?? envelope));
      }
    }
  });
  return promise;
};

export type KakaoInbound = KakaoMessage & { readonly room: KakaoRoom };

export type KakaoInboundStore = { load(): number | undefined; save(seq: number): void };

export const fileKakaoStore = (path: string): KakaoInboundStore => ({
  load() {
    try {
      const n = Number(readFileSync(path, "utf8").trim());
      return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
    } catch {
      return undefined;
    }
  },
  save(seq) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, String(seq), { mode: 0o600 });
    renameSync(tmp, path);
  },
});

/**
 * One pass over messages received since the stored cursor. Only messages someone else wrote in an open chat are
 * emitted; the Dori's own sends and every ordinary room are passed over (they stay readable with `dori kakaotalk read`).
 * A room the archive does not know yet (an open chat joined after the last room sync) triggers one sync and is looked
 * up again; if it is still unknown it is treated as ordinary, the safe side. A first run starts at the archive's tail
 * instead of replaying everything stored before it.
 */
export const pollKakaoInbound = async (
  archive: KakaoArchive,
  store: KakaoInboundStore,
  sync: () => Promise<void>,
  emit: (inbound: KakaoInbound) => void,
): Promise<KakaoInbound[]> => {
  let after = store.load();
  if (after === undefined) {
    store.save(archive.lastSeq());
    return [];
  }
  const out: KakaoInbound[] = [];
  let synced = false;
  for (;;) {
    const batch = archive.messagesAfter(after);
    if (batch.length === 0) return out;
    for (const m of batch) {
      let room = archive.room(m.chatId);
      if (!room && !synced) {
        synced = true;
        await sync();
        room = archive.room(m.chatId);
      }
      if (room?.open && m.authorId !== archive.selfId) {
        const inbound = { ...m, room };
        emit(inbound); // may throw: the cursor stays before this message, so it is read again
        out.push(inbound);
      }
      after = m.seq;
      store.save(after);
    }
  }
};

export type KakaoContent = { readonly text: string } | { readonly image: string };

/**
 * Sends one text or image to an open chat. An ordinary room, or one the archive does not know, is refused before the
 * bridge is called: nothing reaches the server.
 */
export const sendKakao = async (archive: KakaoArchive, call: KakaoCall, chatId: string, content: KakaoContent, idempotencyKey: string): Promise<string> => {
  const room = archive.room(chatId);
  if (!room) throw new KakaoReadOnlyRoomError(`KAKAO_UNKNOWN_ROOM ${chatId}: not in the archive, so it cannot be shown to be an open chat; nothing was sent`);
  if (!room.open) throw new KakaoReadOnlyRoomError(`KAKAO_READ_ONLY_ROOM ${chatId} (${room.name}): an ordinary room is read-only; nothing was sent`);
  const data = (await call("send_message", {
    room: { chat_id: room.chatId, link_id: room.linkId },
    idempotency_key: idempotencyKey,
    content: "text" in content ? { type: "text", text: content.text } : { type: "image", server_path: content.image },
    accept_use_policy: true,
    allow_read_state_change: true,
  })) as { server_receipt?: { log_id?: string }; outcome?: string };
  return data?.server_receipt?.log_id ?? data?.outcome ?? "unknown";
};

/** The line `dori inbound kakaotalk` prints for one message; the text is JSON-escaped onto one line. */
export const kakaoInboundLine = (i: KakaoInbound): string =>
  `INBOUND kakao-open ${i.chatId} ${i.room.linkId} ${i.logId} ${i.authorId} ${JSON.stringify(i.text)}${i.attachment ? " attachment" : ""} room=${JSON.stringify(i.room.name)}`;
