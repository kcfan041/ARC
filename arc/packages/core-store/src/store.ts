import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDefinition } from '@arc/core-model';
import { applySchema, SCHEMA_VERSION } from './schema.js';

/**
 * 專案儲存
 *
 * 專案目錄結構：
 *   <project>/
 *     arc.db          SQLite：metadata、工具、觀測記錄、註記
 *     objects/        content-addressed 檔案（response body 等）
 *
 * 分工原則（REVIEW.md T4）：
 *   DB 只存 metadata 與參照，大型內容進 objects/。
 *   一個 response body 可能數十 MB，存進 BLOB 會讓 DB 迅速膨脹，
 *   且 content-addressed 天然去重 —— 同一份 JS 不會存兩次。
 */

export type StoredTool = {
  def: ToolDefinition;
  spec: unknown;
  createdAt: number;
  updatedAt: number;
};

export type Approval = {
  toolName: string;
  specHash: string;
  capabilities: string[];
  approvedAt: number;
  note?: string;
};

export type SessionRecord = {
  id: string;
  investigationId?: string;
  startUrl?: string;
  startedAt: number;
  endedAt?: number;
  strategy?: string;
  windowMs?: number;
};

/** 計算 spec 的雜湊，用於判斷工具內容是否改變 */
export function hashSpec(spec: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(spec ?? null))
    .digest('hex')
    .slice(0, 16);
}

export class ProjectStore {
  private db: DatabaseSync;
  private objectsDir: string;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.objectsDir = join(dir, 'objects');
    mkdirSync(this.objectsDir, { recursive: true });

    this.db = new DatabaseSync(join(dir, 'arc.db'));
    applySchema(this.db);
  }

  get path(): string {
    return this.dir;
  }

  get schemaVersion(): number {
    const row = this.db
      .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
      .get() as { value?: string } | undefined;
    return row?.value ? Number(row.value) : SCHEMA_VERSION;
  }

  // ── 工具 ──────────────────────────────────────────

  saveTool(def: ToolDefinition, spec: unknown): void {
    const now = Date.now();
    const existing = this.db
      .prepare(`SELECT created_at FROM tool WHERE name = ?`)
      .get(def.name) as { created_at?: number } | undefined;

    this.db
      .prepare(
        `INSERT INTO tool (
           name, title, description, tier, input_schema, output_schema,
           annotations, capabilities, scope, spec,
           origin_kind, origin_from, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(name) DO UPDATE SET
           title = excluded.title,
           description = excluded.description,
           tier = excluded.tier,
           input_schema = excluded.input_schema,
           output_schema = excluded.output_schema,
           annotations = excluded.annotations,
           capabilities = excluded.capabilities,
           scope = excluded.scope,
           spec = excluded.spec,
           origin_kind = excluded.origin_kind,
           origin_from = excluded.origin_from,
           updated_at = excluded.updated_at`,
      )
      .run(
        def.name,
        def.title ?? null,
        def.description,
        def.tier,
        JSON.stringify(def.inputSchema),
        def.outputSchema ? JSON.stringify(def.outputSchema) : null,
        def.annotations ? JSON.stringify(def.annotations) : null,
        JSON.stringify(def.capabilities),
        def.scope ? JSON.stringify(def.scope) : null,
        JSON.stringify(spec ?? null),
        def.origin.kind,
        def.origin.from ?? null,
        existing?.created_at ?? now,
        now,
      );
  }

  listTools(): StoredTool[] {
    const rows = this.db.prepare(`SELECT * FROM tool ORDER BY name`).all() as Record<
      string,
      unknown
    >[];
    return rows.map((r) => this.rowToTool(r));
  }

  getTool(name: string): StoredTool | undefined {
    const r = this.db.prepare(`SELECT * FROM tool WHERE name = ?`).get(name) as
      | Record<string, unknown>
      | undefined;
    return r ? this.rowToTool(r) : undefined;
  }

  deleteTool(name: string): boolean {
    const info = this.db.prepare(`DELETE FROM tool WHERE name = ?`).run(name);
    return Number(info.changes) > 0;
  }

  private rowToTool(r: Record<string, unknown>): StoredTool {
    const def: ToolDefinition = {
      name: String(r.name),
      description: String(r.description),
      tier: String(r.tier) as ToolDefinition['tier'],
      inputSchema: JSON.parse(String(r.input_schema)),
      capabilities: JSON.parse(String(r.capabilities)),
      origin: {
        kind: String(r.origin_kind) as ToolDefinition['origin']['kind'],
        ...(r.origin_from ? { from: String(r.origin_from) } : {}),
      },
      ...(r.title ? { title: String(r.title) } : {}),
      ...(r.output_schema
        ? { outputSchema: JSON.parse(String(r.output_schema)) }
        : {}),
      ...(r.annotations ? { annotations: JSON.parse(String(r.annotations)) } : {}),
      ...(r.scope ? { scope: JSON.parse(String(r.scope)) } : {}),
    };
    return {
      def,
      spec: JSON.parse(String(r.spec)),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  // ── 信任記錄 ──────────────────────────────────────

  /**
   * 核准一個工具。
   *
   * 核准綁定到 spec 的雜湊而非工具名稱 ——
   * 工具內容改變後舊的核准不再適用，必須重新確認。
   */
  approveTool(
    name: string,
    spec: unknown,
    capabilities: string[],
    note?: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO tool_approval
           (tool_name, spec_hash, capabilities, approved_at, note)
         VALUES (?,?,?,?,?)
         ON CONFLICT(tool_name, spec_hash) DO UPDATE SET
           approved_at = excluded.approved_at,
           note = excluded.note`,
      )
      .run(name, hashSpec(spec), JSON.stringify(capabilities), Date.now(), note ?? null);
  }

  /** 該工具的「當前內容」是否已被核准 */
  isApproved(name: string, spec: unknown): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS ok FROM tool_approval WHERE tool_name = ? AND spec_hash = ?`,
      )
      .get(name, hashSpec(spec));
    return !!row;
  }

  listApprovals(name?: string): Approval[] {
    const rows = (
      name
        ? this.db
            .prepare(`SELECT * FROM tool_approval WHERE tool_name = ?`)
            .all(name)
        : this.db.prepare(`SELECT * FROM tool_approval`).all()
    ) as Record<string, unknown>[];
    return rows.map((r) => ({
      toolName: String(r.tool_name),
      specHash: String(r.spec_hash),
      capabilities: JSON.parse(String(r.capabilities)),
      approvedAt: Number(r.approved_at),
      ...(r.note ? { note: String(r.note) } : {}),
    }));
  }

  // ── Session ───────────────────────────────────────

  saveSession(s: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO session
           (id, investigation_id, start_url, started_at, ended_at, strategy, window_ms)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           ended_at = excluded.ended_at,
           strategy = excluded.strategy,
           window_ms = excluded.window_ms`,
      )
      .run(
        s.id,
        s.investigationId ?? null,
        s.startUrl ?? null,
        s.startedAt,
        s.endedAt ?? null,
        s.strategy ?? null,
        s.windowMs ?? null,
      );
  }

  listSessions(): SessionRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM session ORDER BY started_at DESC`)
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      startedAt: Number(r.started_at),
      ...(r.investigation_id ? { investigationId: String(r.investigation_id) } : {}),
      ...(r.start_url ? { startUrl: String(r.start_url) } : {}),
      ...(r.ended_at ? { endedAt: Number(r.ended_at) } : {}),
      ...(r.strategy ? { strategy: String(r.strategy) } : {}),
      ...(r.window_ms ? { windowMs: Number(r.window_ms) } : {}),
    }));
  }

  /**
   * 批次寫入觀測記錄。
   *
   * 用交易包起來 —— 單筆 insert 在 SQLite 中各自 fsync，
   * 數千筆 flow 會慢到不可接受。
   */
  saveObservations(
    sessionId: string,
    actions: { id: string; kind: string; at: number; pageUrl?: string; target: unknown }[],
    flows: {
      id: string;
      requestId: string;
      url: string;
      method: string;
      resourceType?: string;
      at: number;
      redirectIndex: number;
      initiator?: unknown;
    }[],
    bindings: { actionId: string; flowIds: string[]; strategy: string; windowMs: number }[],
  ): void {
    this.db.exec('BEGIN');
    try {
      const insAction = this.db.prepare(
        `INSERT OR REPLACE INTO action
           (id, session_id, seq, kind, at, page_url, target)
         VALUES (?,?,?,?,?,?,?)`,
      );
      actions.forEach((a, i) => {
        insAction.run(
          a.id,
          sessionId,
          i,
          a.kind,
          a.at,
          a.pageUrl ?? null,
          JSON.stringify(a.target),
        );
      });

      const insFlow = this.db.prepare(
        `INSERT OR REPLACE INTO flow
           (id, session_id, request_id, url, method, resource_type,
            at, redirect_index, initiator)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      );
      for (const f of flows) {
        insFlow.run(
          f.id,
          sessionId,
          f.requestId,
          f.url,
          f.method,
          f.resourceType ?? null,
          f.at,
          f.redirectIndex,
          f.initiator ? JSON.stringify(f.initiator) : null,
        );
      }

      this.db.prepare(`DELETE FROM binding WHERE session_id = ?`).run(sessionId);
      const insBinding = this.db.prepare(
        `INSERT OR REPLACE INTO binding
           (session_id, action_id, flow_id, strategy, window_ms)
         VALUES (?,?,?,?,?)`,
      );
      for (const b of bindings) {
        for (const flowId of b.flowIds) {
          insBinding.run(sessionId, b.actionId, flowId, b.strategy, b.windowMs);
        }
      }

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  loadObservations(sessionId: string) {
    const actions = this.db
      .prepare(`SELECT * FROM action WHERE session_id = ? ORDER BY seq`)
      .all(sessionId) as Record<string, unknown>[];
    const flows = this.db
      .prepare(`SELECT * FROM flow WHERE session_id = ? ORDER BY at`)
      .all(sessionId) as Record<string, unknown>[];
    const bindings = this.db
      .prepare(`SELECT * FROM binding WHERE session_id = ?`)
      .all(sessionId) as Record<string, unknown>[];

    const byAction = new Map<string, { actionId: string; flowIds: string[]; strategy: string; windowMs: number }>();
    for (const b of bindings) {
      const key = String(b.action_id);
      const entry = byAction.get(key) ?? {
        actionId: key,
        flowIds: [],
        strategy: String(b.strategy),
        windowMs: Number(b.window_ms),
      };
      entry.flowIds.push(String(b.flow_id));
      byAction.set(key, entry);
    }

    return {
      actions: actions.map((a) => ({
        id: String(a.id),
        kind: String(a.kind),
        at: Number(a.at),
        pageUrl: a.page_url ? String(a.page_url) : undefined,
        target: JSON.parse(String(a.target)),
      })),
      flows: flows.map((f) => ({
        id: String(f.id),
        requestId: String(f.request_id),
        url: String(f.url),
        method: String(f.method),
        resourceType: f.resource_type ? String(f.resource_type) : undefined,
        at: Number(f.at),
        redirectIndex: Number(f.redirect_index),
        initiator: f.initiator ? JSON.parse(String(f.initiator)) : undefined,
      })),
      bindings: [...byAction.values()],
    };
  }

  // ── Artifact（content-addressed）────────────────────

  /** 存入內容，回傳雜湊。相同內容只寫一次。 */
  putObject(content: string | Buffer, mime?: string, url?: string): string {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const hash = createHash('sha256').update(buf).digest('hex').slice(0, 32);
    const file = join(this.objectsDir, hash);

    if (!existsSync(file)) writeFileSync(file, buf);

    this.db
      .prepare(
        `INSERT INTO artifact (hash, size, mime, url, first_seen)
         VALUES (?,?,?,?,?)
         ON CONFLICT(hash) DO NOTHING`,
      )
      .run(hash, buf.length, mime ?? null, url ?? null, Date.now());

    return hash;
  }

  getObject(hash: string): Buffer | undefined {
    const file = join(this.objectsDir, hash);
    return existsSync(file) ? readFileSync(file) : undefined;
  }

  // ── 註記 ──────────────────────────────────────────

  addNote(
    targetKind: string,
    targetId: string,
    body: string,
    opts: { sessionId?: string; bookmarked?: boolean } = {},
  ): string {
    const id = `note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.db
      .prepare(
        `INSERT INTO note
           (id, target_kind, target_id, session_id, body, bookmarked, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        targetKind,
        targetId,
        opts.sessionId ?? null,
        body,
        opts.bookmarked ? 1 : 0,
        Date.now(),
      );
    return id;
  }

  listNotes(targetKind?: string, targetId?: string) {
    const rows = (
      targetKind && targetId
        ? this.db
            .prepare(
              `SELECT * FROM note WHERE target_kind = ? AND target_id = ?
               ORDER BY created_at DESC`,
            )
            .all(targetKind, targetId)
        : this.db.prepare(`SELECT * FROM note ORDER BY created_at DESC`).all()
    ) as Record<string, unknown>[];

    return rows.map((r) => ({
      id: String(r.id),
      targetKind: String(r.target_kind),
      targetId: String(r.target_id),
      body: String(r.body),
      bookmarked: Number(r.bookmarked) === 1,
      createdAt: Number(r.created_at),
    }));
  }

  close(): void {
    this.db.close();
  }
}
