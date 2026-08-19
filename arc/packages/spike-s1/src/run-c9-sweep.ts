import { startRecording } from '@arc/browser-runtime';
import { bindStrategyC, bindStrategyD } from '@arc/correlator';
import { startFixtureServer, FIXTURE_URL } from './fixture/server.js';

/**
 * c9 相位掃描
 *
 * 問題：
 *   c9（輪詢與點擊共用同一端點）的成敗取決於
 *   「點擊落在輪詢週期的哪個相位」。
 *   主量測腳本用固定的等待時間，相位是固定的，
 *   因此 c9 的結果看起來是穩定的 —— 但那是假象。
 *
 * 本腳本刻意在點擊前插入隨機延遲，掃過整個週期，
 * 量出 c9 的實際成功率，而非單一相位下的結果。
 *
 * 為何不直接調大 tolerance 讓 c9 通過：
 *   那是對 fixture 過擬合。tolerance 調大會讓真正的輪詢
 *   被誤判為使用者觸發，precision 下降。
 *   正確做法是量出取捨曲線，再決定預設值。
 */

const POLL_GAP_MS = 900; // 與 fixture 的 /api/shared 輪詢間隔一致
const SAMPLES = 12;
const TOLERANCES = [0.15, 0.25, 0.35, 0.45];

type Row = { tolerance: number; hit: number; total: number };

async function main() {
  const server = await startFixtureServer();
  const results = new Map<number, Row>();
  for (const t of TOLERANCES) results.set(t, { tolerance: t, hit: 0, total: 0 });
  let cHit = 0;

  console.log('');
  console.log('c9 相位掃描 — 輪詢與點擊共用端點');
  console.log('════════════════════════════════════════════════════════');
  console.log(`輪詢間隔 ${POLL_GAP_MS}ms，取樣 ${SAMPLES} 個相位`);
  console.log('');

  for (let i = 0; i < SAMPLES; i += 1) {
    const phaseMs = Math.round((POLL_GAP_MS / SAMPLES) * i);
    const session = await startRecording({ headless: true });
    try {
      await session.page.goto(FIXTURE_URL, { waitUntil: 'load' });
      // 先讓輪詢建立穩定節奏，再對齊到一次實際的輪詢事件上，
      // 最後才加入 phase 偏移。
      //
      // 若直接用固定等待（例如 3000+phase），基準點本身
      // 相對於輪詢週期是任意的，掃描到的相位分佈會失真 ——
      // 初版即因此得出「12/12 全過」的假結果，
      // 與主量測腳本的失敗互相矛盾。
      await session.page.waitForTimeout(3000);
      const pollsBefore = session.flows.filter((f) =>
        f.url.includes('/api/shared'),
      ).length;
      // 等到下一次輪詢真正發生
      const deadline = Date.now() + POLL_GAP_MS * 2;
      while (
        session.flows.filter((f) => f.url.includes('/api/shared')).length ===
          pollsBefore &&
        Date.now() < deadline
      ) {
        await session.page.waitForTimeout(20);
      }
      // 此刻相位≈0，再加入偏移
      if (phaseMs > 0) await session.page.waitForTimeout(phaseMs);
      await session.page.click('#c9-btn');
      await session.page.waitForTimeout(1500);

      const action = session.actions.find((a) => a.target.id === 'c9-btn');
      const c9flow = session.flows.find((f) => f.marker === 'c9');
      if (!action || !c9flow) {
        console.log(`  phase +${String(phaseMs).padStart(3)}ms  (未錄到，跳過)`);
        continue;
      }

      const cBind = bindStrategyC(session.actions, session.flows, {
        windowMs: 500,
      }).find((b) => b.actionId === action.id);
      if (cBind?.flowIds.includes(c9flow.id)) cHit += 1;

      const marks: string[] = [];
      for (const t of TOLERANCES) {
        const row = results.get(t)!;
        row.total += 1;
        const bound = bindStrategyD(session.actions, session.flows, {
          windowMs: 500,
          rhythmTolerance: t,
        }).find((b) => b.actionId === action.id);
        const ok = !!bound?.flowIds.includes(c9flow.id);
        if (ok) row.hit += 1;
        marks.push(ok ? '✓' : '·');
      }
      console.log(
        `  phase +${String(phaseMs).padStart(3)}ms   D: ${marks.join(' ')}`,
      );
    } finally {
      await session.close();
    }
  }

  await server.close();

  console.log('');
  console.log('結果');
  console.log('────────────────────────────────────────────────────────');
  console.log(`C-periodic          c9 命中 ${cHit}/${SAMPLES}（預期為 0）`);
  console.log('');
  console.log('tolerance   c9 命中率   說明');
  for (const t of TOLERANCES) {
    const r = results.get(t)!;
    const rate = r.total ? (r.hit / r.total) * 100 : 0;
    const note =
      t <= 0.2
        ? '寬鬆，易把輪詢誤判為使用者觸發'
        : t >= 0.4
          ? '嚴格，易漏掉使用者觸發'
          : '';
    console.log(
      `  ${t.toFixed(2)}      ${rate.toFixed(0).padStart(3)}%  (${r.hit}/${r.total})   ${note}`,
    );
  }
  console.log('');
  console.log('註：tolerance 越大代表「要偏離節奏越多才算使用者觸發」，');
  console.log('    因此 c9 命中率隨 tolerance 上升而下降。');
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
