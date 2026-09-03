/**
 * Response body 擷取策略
 *
 * ── 為何需要擷取，而不只是記錄 URL ──────────────────
 *
 * 對多數資源而言 URL 就夠了。但有兩種情況不夠：
 *
 *   簽名 URL 會過期     反爬站的媒體連結常帶時效簽名
 *   內容綁 session      登出後同一個 URL 就取不到
 *
 * 這些情況下當下沒存就永遠拿不到。
 *
 * ── 為何是持續成本 ──────────────────────────────────
 *
 * CDP 的 response body 在導航時會被清空，因此不能按需擷取，
 * 必須在 loadingFinished 當下就抓。這代表每一筆都要處理，
 * 成本是持續的而非一次性的 —— 所以需要預算控制。
 */

export type CaptureOptions = {
  /** 單筆上限。超過只存前綴並標記 truncated。 */
  maxBodyBytes?: number;
  /** 單次 session 的總量上限。達標後停止擷取，但錄製繼續。 */
  maxTotalBytes?: number;
  /**
   * 是否擷取串流 segment（HLS / DASH）。
   *
   * 預設關閉不是政策判斷，而是實務問題：一支影片可能有
   * 數百個 segment，會吃掉整個預算，讓其他資源存不下。
   */
  captureStreamSegments?: boolean;
  /** 完全不擷取 body，只記錄 metadata */
  disableBodyCapture?: boolean;
};

export const DEFAULT_CAPTURE: Required<CaptureOptions> = {
  maxBodyBytes: 25 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  captureStreamSegments: false,
  disableBodyCapture: false,
};

/**
 * 串流 segment 的判定。
 *
 * 涵蓋 HLS（.ts / .m4s）與 DASH（.mp4 分片）的常見形式。
 * playlist 本身（.m3u8 / .mpd）不算 segment —— 它很小，
 * 且是理解串流結構的關鍵，應該要存。
 */
export function isStreamSegment(url: string, mimeType?: string): boolean {
  const path = url.split('?')[0] ?? '';

  if (/\.(m3u8|mpd)$/i.test(path)) return false;
  if (/\.(ts|m4s)$/i.test(path)) return true;
  if (mimeType === 'video/mp2t' || mimeType === 'video/iso.segment') return true;

  // 常見的 segment 命名慣例：seg-1.mp4、chunk_0003.mp4
  if (/\/(seg|segment|chunk|frag)[-_]?\d+\.\w+$/i.test(path)) return true;

  return false;
}

/** 擷取預算的追蹤器。單一 session 共用一個。 */
export class CaptureBudget {
  private used = 0;
  private skippedCount = 0;
  private exceededAt?: number;

  constructor(private readonly opts: Required<CaptureOptions>) {}

  get usedBytes(): number {
    return this.used;
  }

  get totalBytes(): number {
    return this.opts.maxTotalBytes;
  }

  get exceeded(): boolean {
    return this.used >= this.opts.maxTotalBytes;
  }

  /** 因預算或策略而未擷取的筆數 */
  get skipped(): number {
    return this.skippedCount;
  }

  /** 預算耗盡的時間點，供 UI 提示 */
  get exceededSince(): number | undefined {
    return this.exceededAt;
  }

  /** 是否應擷取此資源 */
  shouldCapture(url: string, mimeType?: string): boolean {
    if (this.opts.disableBodyCapture) return false;
    if (this.exceeded) return false;
    if (!this.opts.captureStreamSegments && isStreamSegment(url, mimeType)) {
      return false;
    }
    return true;
  }

  /** 記錄一筆略過 */
  noteSkipped(): void {
    this.skippedCount += 1;
  }

  /**
   * 嘗試扣除額度。
   *
   * 回傳實際可用的位元組數：
   *   完整額度   正常擷取
   *   部分額度   剩餘預算不足，只能存一部分
   *   0          預算已耗盡
   */
  allocate(size: number): number {
    if (this.exceeded) {
      this.skippedCount += 1;
      return 0;
    }
    const remaining = this.opts.maxTotalBytes - this.used;
    const grant = Math.min(size, remaining, this.opts.maxBodyBytes);
    this.used += grant;
    if (this.used >= this.opts.maxTotalBytes && this.exceededAt === undefined) {
      this.exceededAt = Date.now();
    }
    return grant;
  }

  get maxBodyBytes(): number {
    return this.opts.maxBodyBytes;
  }
}
