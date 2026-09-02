/**
 * 套件邊界規則
 *
 * 對應 MVP1-PLAN.md 3.7「套件邊界與強制手段」。
 *
 * 核心原則（MVP1-PLAN.md 3.0）：
 *   工具本身不設限。限制屬於 agent-facade，不屬於 core-tools。
 *
 * 部分規則所指的套件（core-tools / agent-facade / agent / gui / cli）
 * 目前尚未建立。規則先寫下來，避免日後補寫時已經違規。
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: '套件之間不得有循環依賴',
      from: {},
      to: { circular: true },
    },

    // ── MVP1-PLAN 3.7：agent 只能經由 facade ──────────────────
    {
      name: 'agent-must-use-facade',
      severity: 'error',
      comment:
        'agent 不得直接使用 core-tools，必須經由 agent-facade。' +
        '這是「限制只作用於 LLM、不作用於人工」的結構性保證。',
      from: { path: '^packages/agent/' },
      to: { path: '^packages/core-tools/' },
    },
    {
      name: 'agent-inner-packages-forbidden',
      severity: 'error',
      comment: 'agent 不得直接觸及任何內層套件',
      from: { path: '^packages/agent/' },
      to: {
        path: '^packages/(browser-runtime|static-analyzer|correlator|core-store|tool-runtime)/',
      },
    },

    // ── MVP1-PLAN 3.7：GUI / CLI 只依賴 core-tools ─────────────
    {
      name: 'ui-only-core-tools',
      severity: 'error',
      comment:
        'gui / cli 只能經由 core-tools 存取能力。' +
        '若允許繞過，GUI 與 Agent 的能力會逐漸失衡，違反 §42 原則 3。',
      from: { path: '^packages/(gui|cli)/' },
      to: {
        path: '^packages/(browser-runtime|static-analyzer|correlator|core-store)/',
      },
    },

    // ── 工具框架的邊界 ────────────────────────────────────────
    {
      name: 'tool-runtime-stays-pure',
      severity: 'error',
      comment:
        'tool-runtime 只負責註冊、能力注入與宣告式執行，' +
        '不得依賴任何具體能力來源。能力由呼叫端以 provide() 注入，' +
        '這是「未宣告的能力不存在」得以成立的前提。',
      from: { path: '^packages/tool-runtime/' },
      to: {
        path: '^packages/(?!core-model|tool-runtime)',
      },
    },

    // ── core-tools 不得反向依賴上層 ───────────────────────────
    {
      name: 'core-tools-no-upward-deps',
      severity: 'error',
      comment: 'core-tools 是最外層的統一介面，不得依賴任何呼叫端',
      from: { path: '^packages/core-tools/' },
      to: { path: '^packages/(gui|cli|agent|agent-facade)/' },
    },

    // ── core-model 保持零依賴 ─────────────────────────────────
    {
      name: 'core-model-stays-pure',
      severity: 'error',
      comment: 'core-model 只放型別，不得依賴任何其他套件',
      from: { path: '^packages/core-model/' },
      to: { path: '^packages/(?!core-model)' },
    },

    // ── spike 程式碼不得被產品程式碼引用 ──────────────────────
    {
      name: 'no-one-depends-on-spikes',
      severity: 'error',
      comment: 'spike 程式碼預期會被丟棄，產品套件不得依賴它',
      from: { pathNot: '^packages/spike-' },
      to: { path: '^packages/spike-' },
    },

    {
      name: 'no-orphans',
      severity: 'info',
      from: { orphan: true, pathNot: '\\.d\\.ts$' },
      to: {},
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(node_modules|dist)' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
  },
};
