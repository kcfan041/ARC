import { startRecording } from '@arc/browser-runtime';
import {
  CLOCK_SKEW_TOLERANCE_MS,
  measureClockSkew,
  pickCalibration,
} from '@arc/core-model';
import { startFixtureServer, FIXTURE_URL } from './fixture/server.js';

/**
 * 時基對齊驗證
 *
 * 對應 SPIKES.md S1 的前置問題，以及計畫中的「寫策略前必須先過」。
 *
 * 為何必須先做：
 *   CDP 的 timestamp 是單調時鐘（秒），注入腳本用的是 Date.now()。
 *   若兩者換算有偏差，N=200ms 的時間窗量測結果即失真 ——
 *   而那正是 c2（debounce 300ms）要測的邊界。
 *
 * 本檢查若不通過，S1 的所有量測結果都不可信。
 */

async function main() {
  const server = await startFixtureServer();
  const session = await startRecording({ headless: true });

  try {
    await session.page.goto(FIXTURE_URL, { waitUntil: 'load' });

    // 讓輪詢跑一段時間，累積足夠的校準樣本
    await session.page.waitForTimeout(4000);

    const cal = pickCalibration(session.calibrations);
    if (!cal) {
      console.error('FAIL: 沒有取得任何時基校準樣本');
      process.exitCode = 1;
      return;
    }

    const skew = measureClockSkew(session.calibrations, cal);

    // 額外檢查：注入腳本的 Date.now() 與 Node 的 Date.now() 是否一致
    const pageNow = await session.page.evaluate(() => Date.now());
    const nodeNow = Date.now();
    const crossProcessSkew = Math.abs(pageNow - nodeNow);

    console.log('');
    console.log('時基對齊驗證');
    console.log('════════════════════════════════════════════');
    console.log(`校準樣本數            ${skew.n}`);
    console.log(`monotonic→epoch 中位誤差  ${skew.medianAbsErrorMs} ms`);
    console.log(`monotonic→epoch 最大誤差  ${skew.maxAbsErrorMs} ms`);
    console.log(`頁面 vs Node 時鐘差    ${crossProcessSkew} ms`);
    console.log(`容許上限              ${CLOCK_SKEW_TOLERANCE_MS} ms`);
    console.log('');

    const ok =
      skew.maxAbsErrorMs <= CLOCK_SKEW_TOLERANCE_MS &&
      crossProcessSkew <= CLOCK_SKEW_TOLERANCE_MS;

    if (ok) {
      console.log('PASS — 時基一致，可進行策略量測');
    } else {
      console.log('FAIL — 時基不一致，量測結果將不可信');
      console.log('');
      console.log('可能原因：');
      console.log('  - CDP wallTime 與 monotonic timestamp 的原點偏移未正確處理');
      console.log('  - 瀏覽器程序與 Node 程序的時鐘不同步');
      process.exitCode = 1;
    }
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
