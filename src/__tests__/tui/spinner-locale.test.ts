// Task 9: spinner 本地化单元测试
//
// 验证：
// - thinkingStatusText / thoughtStatusText 通过 Translator 返回当前语言文案，duration/effort 原样透传。
// - sampleVerb 在没有配置时返回当前语言内置动词；配置的 custom verb 原样返回（不翻译）。
//   内置词库选择基于 Language（不再依赖 translator 字符串探针），en 运行时词库为 SPINNER_VERBS。
// - createSpinnerStore 接收 languageStore，start 后 verb 来自该语言内置词库。

import { describe, it, expect } from 'vitest';
import { createLanguageStore } from '../../locale/language-store.js';
import { createTranslator } from '../../locale/translator.js';
import type { Translator } from '../../locale/types.js';
import { zhCN } from '../../locale/resources/zh-CN.js';
import {
  thinkingStatusText,
  thoughtStatusText,
  createSpinnerStore,
} from '../../tui/state/spinner-store.js';
import { sampleVerb, SPINNER_VERBS } from '../../tui/state/spinner-verbs.js';

const zhTranslator: Translator = createTranslator(createLanguageStore('zh-CN'));
const enTranslator: Translator = createTranslator(createLanguageStore('en-US'));

describe('spinner 本地化', () => {
  describe('thinkingStatusText', () => {
    it('zh：无 effort 返回 "思考中"', () => {
      expect(thinkingStatusText(null, zhTranslator)).toBe('思考中');
    });

    it('zh：有 effort 返回 "思考中 {effort}"，effort 原样透传', () => {
      expect(thinkingStatusText('high', zhTranslator)).toBe('思考中 high');
    });

    it('en：无 effort 返回 "thinking"', () => {
      expect(thinkingStatusText(null, enTranslator)).toBe('thinking');
    });

    it('en：有 effort 返回 "thinking {effort}"，effort 原样透传', () => {
      expect(thinkingStatusText('high', enTranslator)).toBe('thinking high');
    });
  });

  describe('thoughtStatusText', () => {
    it('zh：返回 "思考了 {duration}"，duration 原样', () => {
      expect(thoughtStatusText(5000, zhTranslator)).toBe('思考了 5s');
    });

    it('en：返回 "thought for {duration}"，duration 原样', () => {
      expect(thoughtStatusText(5000, enTranslator)).toBe('thought for 5s');
    });
  });

  describe('sampleVerb', () => {
    it('zh：返回值在内置中文动词数组内（多次抽样均命中）', () => {
      const pool = zhCN.spinner.builtinVerbs as readonly string[];
      for (let i = 0; i < 20; i++) {
        const v = sampleVerb(undefined, 'zh-CN');
        expect(pool).toContain(v);
      }
    });

    it('en：返回值在英文内置动词数组内（SPINNER_VERBS，多次抽样均命中）', () => {
      for (let i = 0; i < 20; i++) {
        const v = sampleVerb(undefined, 'en-US');
        expect(SPINNER_VERBS).toContain(v);
      }
    });

    it('未传 language 时回退到英文 SPINNER_VERBS（向后兼容）', () => {
      for (let i = 0; i < 20; i++) {
        const v = sampleVerb();
        expect(SPINNER_VERBS).toContain(v);
      }
    });

    it('配置的 custom verb 原样返回（replace 模式，不翻译）', () => {
      expect(sampleVerb({ verbs: ['Customizing'], mode: 'replace' }, 'zh-CN'))
        .toBe('Customizing');
    });
  });

  describe('createSpinnerStore', () => {
    it('zh：每次 start 后 verb 均在中文内置词库（多次抽样，覆盖回退到英文的 bug）', () => {
      const languageStore = createLanguageStore('zh-CN');
      const pool = zhCN.spinner.builtinVerbs as readonly string[];
      const store = createSpinnerStore(undefined, undefined, languageStore);
      for (let i = 0; i < 20; i++) {
        store.getState().start('responding');
        expect(pool).toContain(store.getState().verb);
      }
    });

    it('en：每次 start 后 verb 均在英文内置词库 SPINNER_VERBS（多次抽样）', () => {
      const languageStore = createLanguageStore('en-US');
      const store = createSpinnerStore(undefined, undefined, languageStore);
      for (let i = 0; i < 20; i++) {
        store.getState().start('responding');
        expect(SPINNER_VERBS).toContain(store.getState().verb);
      }
    });

    it('未传 languageStore 时回退到英文 SPINNER_VERBS（向后兼容旧 fixture）', () => {
      const store = createSpinnerStore();
      for (let i = 0; i < 20; i++) {
        store.getState().start('responding');
        expect(SPINNER_VERBS).toContain(store.getState().verb);
      }
    });

    it('运行时切换语言后，下一次 start 的 verb 来自新语言词库', () => {
      const languageStore = createLanguageStore('en-US');
      const zhPool = zhCN.spinner.builtinVerbs as readonly string[];
      const store = createSpinnerStore(undefined, undefined, languageStore);
      // 先英文一次
      store.getState().start('responding');
      expect(SPINNER_VERBS).toContain(store.getState().verb);
      // 切到中文后多次抽样必须全部落在中文词库
      languageStore.getState().setLanguage('zh-CN');
      for (let i = 0; i < 10; i++) {
        store.getState().start('responding');
        expect(zhPool).toContain(store.getState().verb);
      }
    });
  });
});
