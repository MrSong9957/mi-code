import React from 'react';
import { Text } from 'ink';
import { act } from '@testing-library/react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { createLanguageStore } from '../../locale/language-store.js';
import { createTranslator } from '../../locale/translator.js';
import { LocaleProvider, useLocale } from '../../locale/context.js';
import { zhCN } from '../../locale/resources/zh-CN.js';
import { enUS } from '../../locale/resources/en-US.js';

function ResponseLanguagePreference(): React.ReactElement {
  const { t } = useLocale();
  return React.createElement(Text, null, t('agent.responseLanguagePreference'));
}

describe('LocaleProvider', () => {
  it('subscribes to the externally created language store', () => {
    const store = createLanguageStore('zh-CN');

    const { lastFrame } = render(
      React.createElement(LocaleProvider, { store },
        React.createElement(ResponseLanguagePreference),
      ),
    );
    // responseLanguagePreference 是长串,ink-testing-library 80 列下会换行
    // (英文空格处换行消费空格、中文字符间插 \n),完整串匹配不可靠。
    // 用稳定开头前缀断言:足够区分语言,且在一行内不换行。
    const zhPref = zhCN.agent.responseLanguagePreference.slice(0, 12);
    const enPref = enUS.agent.responseLanguagePreference.slice(0, 20);

    expect(lastFrame()).toContain(zhPref);

    act(() => {
      store.getState().setLanguage('en-US');
    });

    expect(lastFrame()).toContain(enPref);

    act(() => {
      store.getState().setLanguage('zh-CN');
    });

    expect(lastFrame()).toContain(zhPref);
  });

  it('uses the same externally created translator before and after store changes', () => {
    const store = createLanguageStore('zh-CN');
    const translator = createTranslator(store);

    expect(translator.t('agent.responseLanguagePreference')).toBe(zhCN.agent.responseLanguagePreference);

    store.getState().setLanguage('en-US');

    expect(translator.t('agent.responseLanguagePreference')).toBe(enUS.agent.responseLanguagePreference);
  });
});
