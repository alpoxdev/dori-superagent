import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { fileKakaoStore, findKakaoArchive, KakaoArchive, kakaoInboundLine, KakaoReadOnlyRoomError, pollKakaoInbound, sendKakao } from "../src/messenger/kakaotalk.ts";
import { withState } from "./fakes.ts";

// The bridge's archive schema (kakaotalk-bridge src/kakao/archive_store.rs), with ids past 2^53 as KakaoTalk uses them.
const SELF = "421497482";
const OPEN = "18498738616482001";
const OPEN_LINK = "486372667";
const ROOM = "418083914234178";
const LATE = "18498738616499999";

let state = withState();
afterEach(() => {
  state.done();
  state = withState();
});

const archiveAt = () => {
  const dir = join(state.dir, "kb", "archive", "dori");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${SELF}.sqlite`);
  const db = new Database(path);
  db.run(`CREATE TABLE rooms(chat_id INTEGER NOT NULL, link_id INTEGER NOT NULL, metadata TEXT NOT NULL, PRIMARY KEY(chat_id, link_id));
    CREATE TABLE messages(chat_id INTEGER NOT NULL, log_id INTEGER NOT NULL, author_id INTEGER NOT NULL, "type" INTEGER NOT NULL, text TEXT, attachment TEXT, sent_at INTEGER NOT NULL, source TEXT NOT NULL, PRIMARY KEY(chat_id, log_id));
    CREATE TABLE events(seq INTEGER PRIMARY KEY, method TEXT NOT NULL, chat_id INTEGER, log_id INTEGER, payload TEXT NOT NULL, observed_at INTEGER NOT NULL);`);
  const addRoom = (chat: string, link: string, name: string) =>
    db.run(`INSERT INTO rooms VALUES(${chat}, ${link}, ?)`, [JSON.stringify({ display_name: name, room_type: link === "0" ? 10 : 2 })]);
  let seq = 0;
  const receive = (chat: string, log: string, author: string, text: string, attachment = false) => {
    db.run(`INSERT INTO messages VALUES(${chat}, ${log}, ${author}, 1, ?, ?, 1793925781000, 'loco')`, [text, attachment ? "{}" : null]);
    db.run(`INSERT INTO events VALUES(${++seq}, 'MSG', ${chat}, ${log}, '{}', 0)`);
    db.run(`INSERT INTO events VALUES(${++seq}, 'DECUNREAD', ${chat}, NULL, '{}', 0)`);
  };
  addRoom(OPEN, OPEN_LINK, "민열");
  addRoom(ROOM, "0", "가족");
  return { path, db, addRoom, receive, dataDir: join(state.dir, "kb") };
};

test("the archive is found per profile, rooms are open only with a link id, and huge ids survive as text", () => {
  const a = archiveAt();
  expect(findKakaoArchive(a.dataDir, "dori")).toBe(a.path);
  expect(() => findKakaoArchive(a.dataDir, "other")).toThrow("expected one account archive");
  const archive = new KakaoArchive(a.path);
  expect(archive.selfId).toBe(SELF);
  expect(archive.room(OPEN)).toEqual({ chatId: OPEN, linkId: OPEN_LINK, name: "민열", open: true });
  expect(archive.room(ROOM)?.open).toBe(false);
  expect(archive.rooms().map((r) => r.chatId)).toEqual([OPEN, ROOM]);
});

test("only messages others write in an open chat are emitted; ordinary rooms and the Dori's own sends are passed over", async () => {
  const a = archiveAt();
  const archive = new KakaoArchive(a.path);
  const store = fileKakaoStore(join(state.dir, "kakaotalk-seq"));
  const lines: string[] = [];
  const emit = (i: Parameters<typeof kakaoInboundLine>[0]) => lines.push(kakaoInboundLine(i));
  a.receive(ROOM, "1", "7567102", "before dori started");
  // A first run starts at the tail: nothing stored earlier is replayed.
  expect(await pollKakaoInbound(archive, store, async () => {}, emit)).toEqual([]);
  a.receive(ROOM, "2", "7567102", "family chat");
  a.receive(OPEN, "3967715794991040513", "7552726961492751076", "안녕\n하세요", true);
  a.receive(OPEN, "3967715794991040514", SELF, "my own reply");
  await pollKakaoInbound(archive, store, async () => {}, emit);
  expect(lines).toEqual([`INBOUND kakao-open ${OPEN} ${OPEN_LINK} 3967715794991040513 7552726961492751076 "안녕\\n하세요" attachment room="민열"`]);
  // The cursor moved past everything read, so the next pass is empty.
  expect(await pollKakaoInbound(archive, store, async () => {}, emit)).toEqual([]);
});

test("a room the archive does not know triggers one sync; still unknown, it stays read-only", async () => {
  const a = archiveAt();
  const archive = new KakaoArchive(a.path);
  const store = fileKakaoStore(join(state.dir, "kakaotalk-seq"));
  store.save(0);
  let syncs = 0;
  a.receive(LATE, "10", "99", "joined after the last room sync");
  const found = await pollKakaoInbound(archive, store, async () => {
    syncs++;
    a.addRoom(LATE, "777", "새 오픈채팅");
  }, () => {});
  expect(syncs).toBe(1);
  expect(found.map((i) => i.text)).toEqual(["joined after the last room sync"]);
  a.receive("55", "11", "99", "a room no sync can classify");
  expect(await pollKakaoInbound(archive, store, async () => { syncs++; }, () => {})).toEqual([]);
  expect(syncs).toBe(2);
});

test("a message whose emit fails is read again on the next pass", async () => {
  const a = archiveAt();
  const archive = new KakaoArchive(a.path);
  const store = fileKakaoStore(join(state.dir, "kakaotalk-seq"));
  store.save(0);
  a.receive(OPEN, "20", "99", "keep me");
  await expect(pollKakaoInbound(archive, store, async () => {}, () => { throw new Error("stdout closed"); })).rejects.toThrow("stdout closed");
  expect((await pollKakaoInbound(archive, store, async () => {}, () => {})).map((i) => i.text)).toEqual(["keep me"]);
});

test("sending reaches the bridge only for an open chat; an ordinary or unknown room is refused before any call", async () => {
  const archive = new KakaoArchive(archiveAt().path);
  const calls: [string, Record<string, unknown>][] = [];
  const call = async (tool: string, args: Record<string, unknown>) => {
    calls.push([tool, args]);
    return { server_receipt: { log_id: "3967716565944027136" } };
  };
  await expect(sendKakao(archive, call, ROOM, { text: "hi" }, "k1")).rejects.toBeInstanceOf(KakaoReadOnlyRoomError);
  await expect(sendKakao(archive, call, "12345", { text: "hi" }, "k2")).rejects.toThrow("KAKAO_UNKNOWN_ROOM");
  expect(calls).toEqual([]);
  expect(await sendKakao(archive, call, OPEN, { image: "/tmp/a.png" }, "k3")).toBe("3967716565944027136");
  expect(calls).toEqual([["send_message", {
    room: { chat_id: OPEN, link_id: OPEN_LINK },
    idempotency_key: "k3",
    content: { type: "image", server_path: "/tmp/a.png" },
    accept_use_policy: true,
    allow_read_state_change: true,
  }]]);
});
