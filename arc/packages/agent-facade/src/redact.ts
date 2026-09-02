/**
 * 敏感資料遮蔽
 *
 * 對應 REVIEW.md M5：
 *   「本工具的分析對象包含 cookies、Authorization header、
 *     response body 中的個資。若這些內容被原樣送往第三方 LLM API，
 *     會構成資料外洩風險。」
 *
 * 這是整個 LLM 層唯一不可繞過的環節 ——
 * 所有送往 provider 的內容都必須先經過這裡。
 *
 * ── 設計取捨 ──────────────────────────────────────────
 *
 * 固定欄位遮蔽：零誤判，但抓不到 response body 裡的 token。
 * 啟發式偵測：抓得到，但可能誤判正常內容。
 *
 * 因此採用「遮蔽但保留可還原性」：
 *   遮蔽處以 [已遮蔽:type#id] 標記，
 *   使用者可在 GUI 點開查看原值，並決定是否手動附上。
 *   誤判的代價因此從「資料遺失」降為「多按一次」。
 */

/** 一律遮蔽的 header 名稱（不分大小寫） */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
  'api-key',
  'auth-token',
  'session-id',
  'x-session-token',
]);

/** 值看起來像憑證的欄位名（用於 JSON body 內的鍵） */
const SENSITIVE_KEY_PATTERN =
  /(^|[_\-.])(token|secret|password|passwd|pwd|apikey|api_key|auth|credential|private_key|session|jwt|refresh)($|[_\-.])/i;

export type RedactionType =
  | 'header'
  | 'jwt'
  | 'bearer'
  | 'long-base64'
  | 'email'
  | 'sensitive-key'
  | 'card-number';

export type Redaction = {
  id: string;
  type: RedactionType;
  /** 原始值。留在宿主端，不送往 LLM。 */
  original: string;
  /** 出現位置的描述，供 UI 顯示 */
  path?: string;
};

export type RedactionResult<T> = {
  value: T;
  redactions: Redaction[];
};

/** 遮蔽記錄簿。單次請求共用一本，使相同的值得到相同的標記。 */
class Ledger {
  private byOriginal = new Map<string, Redaction>();
  private seq = 0;

  mark(original: string, type: RedactionType, path?: string): string {
    const existing = this.byOriginal.get(original);
    if (existing) return placeholderOf(existing);

    this.seq += 1;
    const entry: Redaction = {
      id: `r${this.seq}`,
      type,
      original,
      ...(path ? { path } : {}),
    };
    this.byOriginal.set(original, entry);
    return placeholderOf(entry);
  }

  all(): Redaction[] {
    return [...this.byOriginal.values()];
  }
}

function placeholderOf(r: Redaction): string {
  return `[已遮蔽:${r.type}#${r.id}]`;
}

/**
 * 字串層級的啟發式偵測。
 *
 * 順序有意義：JWT 必須先於 long-base64 檢查，
 * 否則 JWT 的三段結構會被當成三個獨立的 base64 片段。
 */
function redactString(input: string, ledger: Ledger, path?: string): string {
  let out = input;

  // JWT：三段 base64url 以點分隔
  out = out.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    (m) => ledger.mark(m, 'jwt', path),
  );

  // Bearer / Basic 等 Authorization 值出現在文字中
  out = out.replace(
    /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
    (m) => ledger.mark(m, 'bearer', path),
  );

  // 長 base64 / hex 字串。門檻設在 40 以避開一般的 id 與 hash 前綴。
  out = out.replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, (m) => {
    // 純數字或含空白的不算
    if (/^\d+$/.test(m)) return m;
    return ledger.mark(m, 'long-base64', path);
  });

  // Email
  out = out.replace(
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    (m) => ledger.mark(m, 'email', path),
  );

  // 信用卡號（13-19 位，允許空格或連字號分隔）
  out = out.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) return m;
    return luhn(digits) ? ledger.mark(m, 'card-number', path) : m;
  });

  return out;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** 遮蔽 header 物件 */
function redactHeaders(
  headers: Record<string, unknown>,
  ledger: Ledger,
  path: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(k.toLowerCase())) {
      out[k] = ledger.mark(String(v), 'header', `${path}.${k}`);
    } else if (typeof v === 'string') {
      out[k] = redactString(v, ledger, `${path}.${k}`);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 遞迴遮蔽任意結構。
 *
 * 對物件的鍵名做語意判斷（token / password / secret 等），
 * 對字串值做啟發式偵測。
 */
function walk(
  value: unknown,
  ledger: Ledger,
  path: string,
  depth = 0,
): unknown {
  if (depth > 32) return value;

  if (typeof value === 'string') {
    return redactString(value, ledger, path);
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => walk(v, ledger, `${path}[${i}]`, depth + 1));
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const childPath = path ? `${path}.${k}` : k;

      // headers 這類欄位整組套用固定規則
      if (/^(headers|requestHeaders|responseHeaders)$/i.test(k) && v && typeof v === 'object') {
        out[k] = redactHeaders(v as Record<string, unknown>, ledger, childPath);
        continue;
      }

      // 鍵名本身就標示為敏感時，整個值遮蔽
      if (SENSITIVE_KEY_PATTERN.test(k) && typeof v === 'string' && v.length > 0) {
        out[k] = ledger.mark(v, 'sensitive-key', childPath);
        continue;
      }

      out[k] = walk(v, ledger, childPath, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * 遮蔽任意值。這是對外的唯一入口。
 *
 * 回傳遮蔽後的結構與一份記錄簿 —— 記錄簿留在宿主端，
 * 只有遮蔽後的內容會送往 LLM。
 */
export function redact<T>(value: T): RedactionResult<T> {
  const ledger = new Ledger();
  const out = walk(value, ledger, '') as T;
  return { value: out, redactions: ledger.all() };
}

/** 還原單一遮蔽項。供 GUI 的「查看原值」使用。 */
export function reveal(
  redactions: Redaction[],
  id: string,
): string | undefined {
  return redactions.find((r) => r.id === id)?.original;
}

/** 供測試與 UI 顯示 */
export { SENSITIVE_HEADERS, SENSITIVE_KEY_PATTERN };
