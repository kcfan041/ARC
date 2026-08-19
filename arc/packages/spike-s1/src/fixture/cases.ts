/**
 * S1 Fixture 案例定義
 *
 * 對應 SPIKES.md S1.3 的 8 個案例。
 *
 * 設計要點：ground truth 由「建構方式」決定，不需人工判讀。
 *   每個由使用者操作觸發的 request，其 URL 帶有 marker 參數，
 *   marker 值等於案例中宣告的 expect 內容。
 *   非使用者觸發的 request（輪詢、prefetch）marker 前綴為 "noise-"。
 *
 * 最可能讓策略失敗的三個案例：2（debounce）、3（async）、4（輪詢）。
 */

export type FixtureCase = {
  id: string;
  title: string;
  /** 操作說明，供人工執行與報告閱讀 */
  how: string;
  /** 此操作「應該」綁定到的 marker 清單。空陣列代表負例。 */
  expect: string[];
  /** 此案例會產生但「不應」綁定的 marker（雜訊） */
  noise?: string[];
  /** 為什麼這個案例有價值 */
  why: string;
};

export const CASES: FixtureCase[] = [
  {
    id: 'c1',
    title: '點擊 → 立即 fetch',
    how: '點擊 #c1-btn',
    expect: ['c1'],
    why: '基準情境。若此案例失敗，代表基礎機制有問題。',
  },
  {
    id: 'c2',
    title: '點擊 → debounce 300ms 後 fetch',
    how: '點擊 #c2-btn',
    expect: ['c2'],
    why: '測時間窗下界。N=200 應該會漏掉，N>=500 應該抓到。',
  },
  {
    id: 'c3',
    title: '點擊 → await 兩層後才 fetch',
    how: '點擊 #c3-btn',
    expect: ['c3'],
    why:
      '測 async 邊界。await 之後 initiator stack 會被截斷，' +
      '策略 B 若過度依賴 stack 可能誤判。',
  },
  {
    id: 'c4',
    title: '背景每 700ms 輪詢（獨立端點 /api/poll）',
    how: '不需操作，載入後自動持續發送',
    expect: [],
    noise: ['noise-poll'],
    why:
      '策略 C 的主要目標。輪詢會落入任何操作的時間窗內，' +
      '是 precision 的最大威脅。' +
      '使用獨立端點，因為 urlPattern 只保留參數名不保留值 —— ' +
      '若與操作共用端點，週期性偵測無法區分兩者（見 c9）。',
  },
  {
    id: 'c5',
    title: '點擊 → 功能 API + analytics beacon',
    how: '點擊 #c5-btn',
    expect: ['c5-api', 'c5-analytics'],
    why:
      '兩者都由該操作觸發，都應綁定。' +
      '「哪個是功能、哪個是埋點」是 LLM 的判讀工作，不是綁定層的職責。',
  },
  {
    id: 'c6',
    title: '點擊 → 完全不發 request',
    how: '點擊 #c6-btn',
    expect: [],
    why:
      '負例。若此時綁到任何東西（例如剛好落入時間窗的輪詢），' +
      '即為 false positive。',
  },
  {
    id: 'c7',
    title: '快速連點兩次，各自觸發不同 request',
    how: '快速點擊 #c7-btn 兩次',
    expect: ['c7-1', 'c7-2'],
    why:
      '測 race。兩個 action 的時間窗重疊，' +
      '純時間窗策略會把兩個 request 都綁給兩個 action。',
  },
  {
    id: 'c8',
    title: '點擊後注入 prefetch',
    how: '點擊 #c8-btn',
    expect: [],
    noise: ['noise-prefetch'],
    why:
      'initiator.type 應為 parser 或 preload，策略 B 應能濾除。' +
      '這是 B 相對 A 的主要價值來源。' +
      '刻意在互動期間才注入 —— 若放在頁面載入時，' +
      '它會落在所有 action 之前，永遠不會成為 false positive，' +
      'B 的價值就測不出來。',
  },
  {
    id: 'c9',
    title: '輪詢與點擊共用同一端點 /api/shared',
    how: '點擊 #c9-btn',
    expect: ['c9'],
    noise: ['noise-shared'],
    why:
      '已知的困難情境。urlPattern 只保留參數名不保留值，' +
      '因此共用端點時，週期性偵測無法區分「輪詢」與「點擊觸發」。' +
      '策略 C 在此案例上會犧牲 recall —— ' +
      '這是刻意保留的失敗案例，用以界定 C 的適用範圍。',
  },
];

/** 需要操作才會觸發的案例。c4 為純背景輪詢，不需操作。 */
export const INTERACTIVE_CASES = CASES.filter((c) => c.id !== 'c4');
