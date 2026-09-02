/**
 * 專案資料庫 Schema
 *
 * 對應 REVIEW.md 的 T4：
 *   「§35 列出要存什麼，但完全沒有實體屬性、主鍵、外鍵、索引，
 *     也沒說 §25 的 graph node/edge 如何映射到關聯式資料表。」
 *
 * ── 為何用 node:sqlite ────────────────────────────────
 *
 * Node 22.5+ 內建，零外部依賴且不需編譯。
 * 這與選 QuickJS 的理由一致 —— 本專案環境會擋 install scripts，
 * better-sqlite3 之類的原生模組在使用者機器上失敗率不低。
 *
 * ── 大型內容不進資料庫 ────────────────────────────────
 *
 * REVIEW.md T4 指出：response body 可達數十 MB，
 * 若存 BLOB 會讓資料庫迅速膨脹。
 * 因此 DB 只存 metadata 與參照，實際內容以 content-addressed
 * 檔案存放（sha256 前 16 碼為檔名），天然去重。
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── 工具 ────────────────────────────────────────────
--
-- Tier 1（宣告式）與 Tier 2（沙箱）都是純資料，可完整存取。
-- Tier 0（原語）的行為在程式碼裡，不入庫。
--
-- capabilities 以 JSON 陣列存放：查詢需求是「這個工具需要什麼」，
-- 而非「誰需要能力 X」，因此不值得為此正規化成關聯表。
CREATE TABLE IF NOT EXISTS tool (
  name         TEXT PRIMARY KEY,
  title        TEXT,
  description  TEXT NOT NULL,
  tier         TEXT NOT NULL,
  input_schema TEXT NOT NULL,
  output_schema TEXT,
  annotations  TEXT,
  capabilities TEXT NOT NULL,
  scope        TEXT,
  spec         TEXT NOT NULL,
  origin_kind  TEXT NOT NULL,
  origin_from  TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_tier ON tool(tier);
CREATE INDEX IF NOT EXISTS idx_tool_origin ON tool(origin_kind);

-- ── 信任記錄 ────────────────────────────────────────
--
-- 與 tool 分開，因為信任是「人對某個版本的工具」的判斷。
-- 工具內容改變後，舊的核准不應自動延續 ——
-- 因此記錄核准當下的 capabilities 與 spec 雜湊。
CREATE TABLE IF NOT EXISTS tool_approval (
  tool_name     TEXT NOT NULL,
  spec_hash     TEXT NOT NULL,
  capabilities  TEXT NOT NULL,
  approved_at   INTEGER NOT NULL,
  approved_by   TEXT NOT NULL DEFAULT 'user',
  note          TEXT,
  PRIMARY KEY (tool_name, spec_hash),
  FOREIGN KEY (tool_name) REFERENCES tool(name) ON DELETE CASCADE
);

-- ── 調查與工作階段 ──────────────────────────────────
CREATE TABLE IF NOT EXISTS investigation (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  goal       TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  id               TEXT PRIMARY KEY,
  investigation_id TEXT,
  start_url        TEXT,
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  strategy         TEXT,
  window_ms        INTEGER,
  FOREIGN KEY (investigation_id) REFERENCES investigation(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_session_inv ON session(investigation_id);

-- ── 觀測記錄 ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS action (
  id         TEXT NOT NULL,
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  at         INTEGER NOT NULL,
  page_url   TEXT,
  target     TEXT NOT NULL,
  PRIMARY KEY (session_id, id),
  FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_action_time ON action(session_id, at);

-- flow 的 body 不存在此表，只留 content-addressed 參照。
CREATE TABLE IF NOT EXISTS flow (
  id             TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  request_id     TEXT NOT NULL,
  url            TEXT NOT NULL,
  method         TEXT NOT NULL,
  resource_type  TEXT,
  at             INTEGER NOT NULL,
  redirect_index INTEGER NOT NULL DEFAULT 0,
  initiator      TEXT,
  req_body_ref   TEXT,
  resp_body_ref  TEXT,
  status         INTEGER,
  PRIMARY KEY (session_id, id),
  FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_flow_time ON flow(session_id, at);
CREATE INDEX IF NOT EXISTS idx_flow_url ON flow(session_id, url);

-- 綁定是策略的產物，不是觀測事實。
-- 因此記錄產生它的策略與參數，日後策略改變時可重新計算。
CREATE TABLE IF NOT EXISTS binding (
  session_id TEXT NOT NULL,
  action_id  TEXT NOT NULL,
  flow_id    TEXT NOT NULL,
  strategy   TEXT NOT NULL,
  window_ms  INTEGER NOT NULL,
  PRIMARY KEY (session_id, action_id, flow_id),
  FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_binding_action ON binding(session_id, action_id);
CREATE INDEX IF NOT EXISTS idx_binding_flow ON binding(session_id, flow_id);

-- ── Artifact ────────────────────────────────────────
--
-- content-addressed：相同內容只存一份，天然去重。
-- 跨 session 共用（同一個 main.js 不會存兩次）。
CREATE TABLE IF NOT EXISTS artifact (
  hash       TEXT PRIMARY KEY,
  size       INTEGER NOT NULL,
  mime       TEXT,
  url        TEXT,
  first_seen INTEGER NOT NULL
);

-- ── 註記 ────────────────────────────────────────────
--
-- 可掛在任何實體上（flow / action / tool / 程式碼位置）。
-- 這是 MVP1-PLAN 2.6 指出的、DevTools 結構上缺少的能力：
-- 「無法對任何東西加註記、書籤、標記」。
CREATE TABLE IF NOT EXISTS note (
  id         TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL,
  target_id  TEXT NOT NULL,
  session_id TEXT,
  body       TEXT NOT NULL,
  bookmarked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_note_target ON note(target_kind, target_id);
`;

/** 建立資料表並記錄版本 */
export function applySchema(db: {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): unknown };
}): void {
  db.exec(SCHEMA_SQL);
  db.prepare(
    `INSERT INTO meta(key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(SCHEMA_VERSION));
}
