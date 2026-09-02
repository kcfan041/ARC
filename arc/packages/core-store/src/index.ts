/**
 * Core Store — 專案持久化
 *
 * 解 REVIEW.md T4（SQLite schema）。
 *
 * 這一層存在的理由（MVP1-PLAN 2.6）：
 *   Chrome DevTools 是優秀的即時檢視器，但關掉分頁後
 *   一切消失。ARC 的差異在於「發現會累積」——
 *   而累積需要一個地方存放。
 */
export * from './schema.js';
export * from './store.js';
