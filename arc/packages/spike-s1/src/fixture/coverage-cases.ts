/**
 * S2 覆蓋率案例
 *
 * 對應 SPIKES.md 的 S2：宣告式規格能表達多少真實採集需求。
 *
 * ── 影響範圍已因三層架構而縮小 ──────────────────────
 *
 * S2 原本是「阻塞項」——若覆蓋率不足，整個安全設計要重做。
 * 三層架構之後它只決定 agent-facade 一層：
 *
 *   Tier 1 表達不了 → 落到 Tier 2 沙箱（仍在我方控制內）
 *   人工任何時候都可直接用 core-tools，不受此限
 *
 * 因此本測試的問題已從「設計可不可行」變成
 * 「LLM 用宣告式能覆蓋多少，剩下的要不要沙箱」。
 *
 * ── 案例來源 ──────────────────────────────────────
 *
 * 目前使用合成案例，涵蓋 SPIKES.md S2.2 列出的所有困難情境。
 * 真實網站的 HAR 待補（需專案發起人提供）。
 * 合成案例的結論偏樂觀，因為真實網站總有意外 ——
 * 這一點必須在結論中誠實標註。
 */

export type CoverageCase = {
  id: string;
  title: string;
  /** 使用者實際想做的事 */
  need: string;
  /** SPIKES.md S2.2 列出的困難點，若適用 */
  difficulty?: string;
  /** 預期由哪一層處理 */
  expect: 'tier1-basic' | 'tier1-chained' | 'tier1-cursor' | 'tier2' | 'none';
  /** 為何是這一層 */
  why: string;
};

export const COVERAGE_CASES: CoverageCase[] = [
  {
    id: 'v1',
    title: '過濾已觀測的請求',
    need: '找出所有圖片與影片的真實網址',
    expect: 'tier1-basic',
    why: '完全不需執行 —— 只是過濾已記錄的 flow。這是最常見的需求。',
  },
  {
    id: 'v2',
    title: '固定範圍翻頁',
    need: '抓搜尋結果的第 1 到 20 頁',
    expect: 'tier1-basic',
    why: 'vary 的 from/to 直接表達，是宣告式模型的標準情境。',
  },
  {
    id: 'v3',
    title: '列舉指定值',
    need: '抓 category=1,5,9 這三類的資料',
    expect: 'tier1-basic',
    why: 'vary 的 values 形式。',
  },
  {
    id: 'v4',
    title: '列表 → 詳情',
    need: '先抓列表取得每個項目的 id，再逐一抓詳情頁',
    difficulty: '需要多步驟流程：先呼叫 A 取得 id，再用 id 呼叫 B',
    expect: 'tier1-chained',
    why: 'chained spec：前一步的 extract 結果經 as 存入變數，後續以 fromVar 取用。',
  },
  {
    id: 'v5',
    title: '游標式分頁',
    need: '無限捲動的列表，下一頁的 cursor 藏在上一頁的回應中',
    difficulty: '游標式分頁；需要條件判斷「有 next 就繼續」',
    expect: 'tier2',
    why:
      '宣告式無法表達「取出回應中的 cursor 並回饋到下一次請求」的迴圈。' +
      'chained spec 只能做固定層數的串接，無法做不定次數的迭代。',
  },
  {
    id: 'v6',
    title: '條件式終止',
    need: '一直翻頁直到回應為空',
    difficulty: '需要條件判斷',
    expect: 'tier2',
    why: '需要在執行期間根據回應內容決定是否繼續，這是控制流。',
  },
  {
    id: 'v7',
    title: '巢狀參數',
    need: '改變 request body 中深層的欄位',
    difficulty: '參數在 body 深處：巢狀 JSON 中的欄位，非頂層參數',
    expect: 'tier2',
    why:
      '目前 replay 只改 query 參數。要改 body 深層欄位需要 JSON path 寫入，' +
      '而那會讓宣告式規格的驗證變複雜 —— 不如交給沙箱。',
  },
  {
    id: 'v8',
    title: 'GraphQL',
    need: '改變 GraphQL query 中的變數',
    difficulty: '整個 query 在單一字串參數中',
    expect: 'tier2',
    why: '需要解析並重組字串內容，超出宣告式的表達範圍。',
  },
  {
    id: 'v9',
    title: '動態 token',
    need: '每次請求的 token 都不同，且來自前一個回應',
    difficulty: '需要動態 token',
    expect: 'tier2',
    why:
      '技術上 chained spec 可以傳遞值，但 token 通常在 header 而非 query，' +
      '而宣告式刻意不允許改 header —— 那是安全保證的一部分。',
  },
  {
    id: 'v10',
    title: '呼叫網站內部函式',
    need: '參數由前端計算，無法從既有請求推導',
    difficulty: '需要呼叫網站函式',
    expect: 'none',
    why:
      '需要 browser.eval，而 MVP1 決定不對 LLM 開放（MVP1-PLAN 3.4）。' +
      '人工仍可直接使用 core-tools 完成。',
  },
  {
    id: 'v11',
    title: '統計與聚合',
    need: '統計各端點的呼叫次數',
    expect: 'tier2',
    why: '需要迴圈與累加。宣告式的 extract 只能抽取，不能聚合。',
  },
  {
    id: 'v12',
    title: '匯出為結構化資料',
    need: '把抓到的結果整理成 CSV 欄位',
    expect: 'tier1-basic',
    why: 'extract 取出欄位後由呼叫端轉換，與執行層無關。',
  },
];
