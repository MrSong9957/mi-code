import React from 'react';
import { Text } from 'ink';
import { act } from '@testing-library/react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { createLanguageStore } from '../../locale/language-store.js';
import { createTranslator } from '../../locale/translator.js';
import { LocaleProvider, useLocale } from '../../locale/context.js';

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

    expect(lastFrame()).toContain('请始终用中文回复。');

    act(() => {
      store.getState().setLanguage('en-US');
    });

    expect(lastFrame()).toContain('Always respond in English.');

    act(() => {
      store.getState().setLanguage('zh-CN');
    });

    expect(lastFrame()).toContain('请始终用中文回复。');
  });

  it('uses the same externally created translator before and after store changes', () => {
    const store = createLanguageStore('zh-CN');
    const translator = createTranslator(store);

    expect(translator.t('agent.responseLanguagePreference')).toBe('请始终用中文回复。');

    store.getState().setLanguage('en-US');

    expect(translator.t('agent.responseLanguagePreference')).toBe('Always respond in English.');
  });
});
