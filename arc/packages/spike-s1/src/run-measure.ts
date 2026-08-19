import { startRecording } from '@arc/browser-runtime';
import {
  CLOCK_SKEW_TOLERANCE_MS,
  measureClockSkew,
  pickCalibration,
  verdictOf,
  type StrategyName,
  type StrategyScore,
} from '@arc/core-model';
import { STRATEGIES } from '@arc/correlator';
import { startFixtureServer, FIXTURE_URL } from './fixture/server.js';
import { evaluate, type CaseOutcome, type ExpectedBinding } from './score.js';

/**
 * S1 量測主程式
 *
 * 流程：
 *   1. 起 fixture 站
 *   2. 起 Chromium（headless）並開始錄製
 *   3. 依序自動執行各案例的操作
 *   4. 驗證時基
 *   5. 對 3 種策略 × 4 種時間窗計算 precision / recall
 *   6. 輸出對照表與逐案失敗記錄
 */

const WINDOWS = [200, 500, 1000, 2000];

/** ground truth：由 fixture 的建構方式決定 */
const EXPECTATIONS: ExpectedBinding[] = [
  { buttonId: 'c1-btn', markers: ['c1'] },
  { buttonId: 'c2-btn', markers: ['c2'] },
  { buttonId: 'c3-btn', markers: ['c3'] },
  { buttonId: 'c5-btn', markers: ['c5-api', 'c5-analytics'] },
  { buttonId: 'c6-btn', markers: [] },
  { buttonId: 'c7-btn', markers: ['c7-1'] },
  { buttonId: 'c7-btn', markers: ['c7-2'] },
  { buttonId: 'c8-btn', markers: [] },
  { buttonId: 'c9-btn', markers: ['c9'] },
];

function pct(n: number): string {
  return (n * 100).toFixed(1).padStart(5) + '%';
}

async function main() {
  const server = await startFixtureServer();
  const session = await startRecording({ headless: true });

  try {
    const page = session.page;
    await page.goto(FIXTURE_URL, { waitUntil: 'load' });

    // 讓 prefetch 與前幾輪輪詢先發生，建立週期性偵測所需的樣本
    await page.waitForTimeout(2500);

    // ── 依序執行各案例 ────────────────────────────────────
    await page.click('#c1-btn');
    await page.waitForTimeout(1200);

    await page.click('#c2-btn');
    await page.waitForTimeout(1500); // debounce 300ms + 餘裕

    await page.click('#c3-btn');
    await page.waitForTimeout(1500); // await 兩層各 60ms

    await page.click('#c5-btn');
    await page.waitForTimeout(1200);

    await page.click('#c6-btn');
    await page.waitForTimeout(1200);

    // c7 快速連點
    await page.click('#c7-btn');
    await page.waitForTimeout(80);
    await page.click('#c7-btn');
    await page.waitForTimeout(1500);

    await page.click('#c8-btn');
    await page.waitForTimeout(1500);

    await page.click('#c9-btn');
    await page.waitForTimeout(1500);

    // ── 時基驗證 ──────────────────────────────────────────
    const cal = pickCalibration(session.calibrations);
    const skew = cal
      ? measureClockSkew(session.calibrations, cal)
      : { maxAbsErrorMs: Infinity, medianAbsErrorMs: Infinity, n: 0 };

    console.log('');
    console.log('S1 — Action ↔ Network 綁定正確率');
    console.log('════════════════════════════════════════════════════════');
    console.log('');
    console.log(`錄到 action  ${session.actions.length}`);
    console.log(`錄到 flow    ${session.flows.length}`);
    console.log(
      `時基誤差     中位 ${skew.medianAbsErrorMs}ms / 最大 ${skew.maxAbsErrorMs}ms ` +
        `(容許 ${CLOCK_SKEW_TOLERANCE_MS}ms)`,
    );

    if (skew.maxAbsErrorMs > CLOCK_SKEW_TOLERANCE_MS) {
      console.log('');
      console.log('⚠ 時基誤差超過容許值，以下量測結果不可信');
    }

    // ── 對照表 ────────────────────────────────────────────
    console.log('');
    console.log('策略 × 時間窗對照');
    console.log('────────────────────────────────────────────────────────');
    console.log('strategy      window   precision   recall      f1  verdict');

    const all: { score: StrategyScore; outcomes: CaseOutcome[] }[] = [];

    for (const name of Object.keys(STRATEGIES) as StrategyName[]) {
      for (const windowMs of WINDOWS) {
        const bindings = STRATEGIES[name](session.actions, session.flows, {
          windowMs,
        });
        const result = evaluate(
          name,
          windowMs,
          session.actions,
          session.flows,
          bindings,
          EXPECTATIONS,
        );
        all.push(result);
        const s = result.score;
        console.log(
          `${name.padEnd(13)} ${String(windowMs).padStart(5)}ms  ` +
            `${pct(s.precision)}   ${pct(s.recall)}  ${pct(s.f1)}  ${verdictOf(s)}`,
        );
      }
      console.log('');
    }

    // ── 最佳組合 ──────────────────────────────────────────
    //
    // 排序依據：先看 verdict 分級，同級再比 f1，最後才比 recall。
    //
    // 不能單純以 recall 排序 —— 那是退化的指標：
    // 一個「把所有 flow 都綁給所有 action」的策略可以取得 recall 1.0，
    // 但完全沒有用。初版實作犯過這個錯，導致
    // A@500ms（precision 36%）被選為最佳，
    // 勝過 C@500ms（precision 87.5% / recall 87.5%）。
    const tier: Record<string, number> = { pass: 0, conditional: 1, fail: 2 };
    const rank = (
      a: (typeof all)[number],
      b: (typeof all)[number],
    ): number => {
      const ta = tier[verdictOf(a.score)] ?? 9;
      const tb = tier[verdictOf(b.score)] ?? 9;
      if (ta !== tb) return ta - tb;
      if (b.score.f1 !== a.score.f1) return b.score.f1 - a.score.f1;
      return b.score.recall - a.score.recall;
    };
    const best = [...all].sort(rank)[0];

    // 各策略的最佳表現與其失敗案例。
    // 若只印全域最佳，分數相同的策略會被穩定排序遮蔽 ——
    // 初版即因此誤以為 D 沒有解決 c9。
    console.log('各策略的最佳表現');
    console.log('────────────────────────────────────────────────────────');
    for (const name of Object.keys(STRATEGIES) as StrategyName[]) {
      const bestOfStrategy = all
        .filter((r) => r.score.strategy === name)
        .sort(rank)[0];
      if (!bestOfStrategy) continue;
      const s = bestOfStrategy.score;
      const fails = bestOfStrategy.outcomes.filter(
        (o) => o.missing.length > 0 || o.extra.length > 0,
      );
      console.log(
        `${name.padEnd(13)} @${String(s.windowMs).padStart(5)}ms  ` +
          `P ${pct(s.precision)}  R ${pct(s.recall)}  ` +
          `未過 ${fails.length ? fails.map((f) => f.buttonId).join(', ') : '無'}`,
      );
    }
    console.log('');

    if (best) {
      console.log('最佳組合（verdict 分級 → f1 → recall）');
      console.log('────────────────────────────────────────────────────────');
      console.log(
        `${best.score.strategy} @ ${best.score.windowMs}ms  →  ` +
          `precision ${pct(best.score.precision)} / recall ${pct(best.score.recall)} / ` +
          `${verdictOf(best.score)}`,
      );
      console.log('');

      const failed = best.outcomes.filter(
        (o) => o.missing.length > 0 || o.extra.length > 0,
      );
      if (failed.length === 0) {
        console.log('所有案例皆正確');
      } else {
        console.log('未通過的案例');
        for (const o of failed) {
          console.log(`  ${o.buttonId}  (${o.actionId})`);
          console.log(`    expected  [${o.expected.join(', ')}]`);
          console.log(`    got       [${o.got.join(', ')}]`);
          if (o.missing.length) console.log(`    漏掉      [${o.missing.join(', ')}]`);
          if (o.extra.length) console.log(`    多抓      [${o.extra.join(', ')}]`);
        }
      }
      console.log('');
    }

    // ── initiator 品質觀察（順帶取得，供 MVP2 的 T1 參考）──
    const withStack = session.flows.filter(
      (f) => (f.initiator.stack?.callFrames.length ?? 0) > 0,
    );
    const scriptInitiated = session.flows.filter(
      (f) => f.initiator.type === 'script',
    );
    console.log('順帶觀察：initiator 資料品質（供 MVP2 position mapping 參考）');
    console.log('────────────────────────────────────────────────────────');
    console.log(`type=script 的 flow      ${scriptInitiated.length}`);
    console.log(`帶 call stack 的 flow    ${withStack.length}`);
    console.log(
      `stack 平均深度           ${
        withStack.length
          ? (
              withStack.reduce(
                (a, f) => a + (f.initiator.stack?.callFrames.length ?? 0),
                0,
              ) / withStack.length
            ).toFixed(1)
          : 'n/a'
      }`,
    );
    console.log('');
  } finally {
    await session.close();
    await server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
