/**
 * Agent Facade —— LLM 的受限介面
 *
 * MVP1-PLAN.md 3.7 的結構性保證：
 *   agent 只能 import 本套件，不得直接觸及 core-tools。
 *   因此「限制只作用於 LLM、不作用於人工」是型別層面成立的，
 *   而非靠約定。
 *
 * 刪除本套件與 agent/ 之後，GUI 與 CLI 完全不受影響。
 */
export * from './redact.js';
export * from './provider.js';
export * from './facade.js';
