import { createHash } from 'node:crypto';
import type {
  Capability,
  ImportReview,
  ToolDefinition,
  ToolPackage,
} from '@arc/core-model';
import {
  READ_ONLY_CAPABILITIES,
  TOOL_PACKAGE_VERSION,
  isToolPackage,
} from '@arc/core-model';

/**
 * 工具封裝、匯出與匯入審查
 *
 * ── 信任模型（MVP1-PLAN 3A.8）──────────────────────────
 *
 *   匯入時   顯示該工具宣告了哪些能力 → 人工確認一次
 *   之後     呼叫不再詢問
 *   記錄     來源、是人寫還是 AI 生成、宣告的能力、是否已審
 *
 * 唯讀工具可考慮免確認 —— 而這個判定依 capabilities 而非
 * annotations，因此可信。一個工具可以謊稱 readOnlyHint: true，
 * 但它宣告的 capabilities 決定了實際能拿到什麼。
 *
 * ── integrity 的用途 ──────────────────────────────────
 *
 * 不是防竄改（攻擊者可同時修改內容與雜湊），
 * 而是偵測傳輸損毀，並讓「核准」綁定到具體內容：
 * 工具內容改變後，先前的核准自動失效。
 */

/** 計算封裝的內容雜湊，涵蓋 def 與 spec */
export function computeIntegrity(def: ToolDefinition, spec: unknown): string {
  // 鍵順序穩定化，避免序列化順序影響雜湊
  const canonical = JSON.stringify({ def: sortKeys(def), spec: sortKeys(spec) });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/** 把工具封裝為可傳輸的格式 */
export function packageTool(
  def: ToolDefinition,
  spec: unknown,
  exportedBy?: string,
): ToolPackage {
  return {
    kind: 'arc.tool-package',
    version: TOOL_PACKAGE_VERSION,
    def,
    spec,
    integrity: computeIntegrity(def, spec),
    exportedAt: Date.now(),
    ...(exportedBy ? { exportedBy } : {}),
  };
}

export type ReviewOptions = {
  /** 本機既有的工具名稱，用於偵測衝突 */
  existingNames?: ReadonlySet<string>;
  /** 本機支援的能力。宣告了未知能力的工具無法執行。 */
  knownCapabilities?: ReadonlySet<Capability>;
};

/**
 * 匯入前審查。
 *
 * 回傳的資訊即為「確認畫面」所需的全部內容。
 * 這個函式不改變任何狀態 —— 決定權留給呼叫端。
 */
export function reviewImport(
  pkg: unknown,
  opts: ReviewOptions = {},
): ImportReview | { error: string } {
  if (!isToolPackage(pkg)) {
    return { error: '不是有效的 ARC 工具封裝格式' };
  }
  if (pkg.version > TOOL_PACKAGE_VERSION) {
    return {
      error: `封裝格式版本 ${pkg.version} 高於本機支援的 ${TOOL_PACKAGE_VERSION}`,
    };
  }

  const def = pkg.def;
  const blockers: string[] = [];
  const warnings: string[] = [];

  // 原語不可匯入 —— 它的行為在程式碼裡，匯入一個同名的
  // 「原語」只會是個空殼，或覆蓋掉真正的內建工具。
  if (def.tier !== 'declarative' && def.tier !== 'sandboxed') {
    blockers.push(
      `只能匯入宣告式或沙箱工具，此封裝的 tier 為 "${def.tier}"`,
    );
  }

  if (!def.name || !/^[a-z][a-z0-9_]*$/i.test(def.name)) {
    blockers.push(`工具名稱不合法：${JSON.stringify(def.name)}`);
  }

  if (!Array.isArray(def.capabilities) || def.capabilities.length === 0) {
    blockers.push('工具未宣告任何能力');
  }

  const known = opts.knownCapabilities;
  if (known) {
    const unknown = (def.capabilities ?? []).filter((c) => !known.has(c));
    if (unknown.length > 0) {
      blockers.push(`宣告了本機不支援的能力：${unknown.join(', ')}`);
    }
  }

  const integrityMismatch = computeIntegrity(def, pkg.spec) !== pkg.integrity;
  if (integrityMismatch) {
    warnings.push(
      '內容雜湊與宣告值不符，封裝可能在傳輸過程中損毀或被修改',
    );
  }

  const nameConflict = opts.existingNames?.has(def.name) ?? false;
  if (nameConflict) {
    warnings.push(`本機已有同名工具 "${def.name}"，匯入將需要重新命名`);
  }

  const capabilities = (def.capabilities ?? []).map((name) => ({
    name,
    readOnly: READ_ONLY_CAPABILITIES.has(name),
  }));
  const allReadOnly =
    capabilities.length > 0 && capabilities.every((c) => c.readOnly);

  if (!allReadOnly) {
    warnings.push(
      '此工具宣告了具副作用的能力，執行時可能改變頁面狀態或發送請求',
    );
  }

  // annotations 是自述，與 capabilities 不符時要明講
  if (def.annotations?.readOnlyHint === true && !allReadOnly) {
    warnings.push(
      '此工具自稱唯讀，但宣告的能力並非全部唯讀。' +
        '以能力宣告為準 —— 自述欄位不可信。',
    );
  }

  return {
    def,
    capabilities,
    allReadOnly,
    nameConflict,
    integrityMismatch,
    blockers,
    warnings,
  };
}

/**
 * 解決名稱衝突。
 *
 * 匯入的工具與內建原語同名時，若直接覆蓋會讓使用者
 * 失去內建功能且難以察覺。因此一律改名而非覆蓋。
 *
 * 命名慣例：外部來源加上前綴，重複則加序號。
 */
export function resolveName(
  desired: string,
  existing: ReadonlySet<string>,
  source?: string,
): string {
  if (!existing.has(desired)) return desired;

  const prefix = source
    ? source.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase()
    : 'imported';

  const prefixed = `${prefix}_${desired}`;
  if (!existing.has(prefixed)) return prefixed;

  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${prefixed}_${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${prefixed}_${Date.now()}`;
}
