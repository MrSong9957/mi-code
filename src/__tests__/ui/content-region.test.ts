import { describe, it, expect, beforeEach } from 'vitest';
import { ContentRegion } from '../../ui/content-region.js';
import type { FormattedLine } from '../../ui/types.js';

describe('ContentRegion', () => {
  let region: ContentRegion;

  beforeEach(() => {
    region = new ContentRegion();
  });

  describe('addLine', () => {
    it('should route thinking to message region', () => {
      region.addLine('thinking', { content: '● Thinking…', style: {}, indent: 0 });
      expect(region.getMessageLines().length).toBe(1);
      expect(region.getToolLines().length).toBe(0);
      expect(region.getSystemLines().length).toBe(0);
    });

    it('should route thinking_content to message region', () => {
      region.addLine('thinking_content', { content: '  内容', style: {}, indent: 2 });
      expect(region.getMessageLines().length).toBe(1);
    });

    it('should route assistant to message region', () => {
      region.addLine('assistant', { content: '● 回复', style: {}, indent: 0 });
      expect(region.getMessageLines().length).toBe(1);
    });

    it('should route tool_call to tool region', () => {
      region.addLine('tool_call', { content: '● Bash(cd ...)', style: {}, indent: 0 });
      expect(region.getToolLines().length).toBe(1);
      expect(region.getMessageLines().length).toBe(0);
    });

    it('should route tool_result to tool region', () => {
      region.addLine('tool_result', { content: '  ⎿  Done', style: {}, indent: 2 });
      expect(region.getToolLines().length).toBe(1);
    });

    it('should route tool_output to tool region', () => {
      region.addLine('tool_output', { content: '  ⎿  > ...', style: {}, indent: 2 });
      expect(region.getToolLines().length).toBe(1);
    });

    it('should route permission to tool region', () => {
      region.addLine('permission', { content: '  ⎿  Allowed', style: {}, indent: 2 });
      expect(region.getToolLines().length).toBe(1);
    });

    it('should route system to system region', () => {
      region.addLine('system', { content: '[Hook] started', style: {}, indent: 0 });
      expect(region.getSystemLines().length).toBe(1);
    });

    it('should route error to system region', () => {
      region.addLine('error', { content: '[Error] failed', style: {}, indent: 0 });
      expect(region.getSystemLines().length).toBe(1);
    });

    it('should route input to system region', () => {
      region.addLine('input', { content: '❯ 你好', style: {}, indent: 0 });
      expect(region.getSystemLines().length).toBe(1);
    });
  });

  describe('getAllLines', () => {
    it('should return all lines in order', () => {
      region.addLine('system', { content: 'system', style: {}, indent: 0 });
      region.addLine('thinking', { content: 'thinking', style: {}, indent: 0 });
      region.addLine('tool_call', { content: 'tool', style: {}, indent: 0 });

      const all = region.getAllLines();
      expect(all.length).toBe(3);
    });
  });

  describe('clear', () => {
    it('should clear all regions', () => {
      region.addLine('thinking', { content: 'test', style: {}, indent: 0 });
      region.addLine('tool_call', { content: 'test', style: {}, indent: 0 });
      region.addLine('system', { content: 'test', style: {}, indent: 0 });

      region.clear();
      expect(region.getMessageLines().length).toBe(0);
      expect(region.getToolLines().length).toBe(0);
      expect(region.getSystemLines().length).toBe(0);
    });
  });
});
