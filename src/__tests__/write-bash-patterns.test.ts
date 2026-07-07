// isWriteBash 模式检测测试
//
// 物理本质：验证"安检员能识别所有藏匿的违禁品（写操作）"。
// 写命令有各种伪装（重定向、管道 tee、sed -i、git commit...），都应被识破。
import { describe, it, expect } from 'vitest';
import { isWriteBash, isDangerousBash } from '../permission/patterns.js';

describe('isWriteBash 写命令检测', () => {
  // 应被检出的写命令
  const writeCommands = [
    'mkdir foo',
    'mkdir -p a/b/c',
    'touch file.txt',
    'rm foo.txt',                    // 单文件 rm（不是 rm -rf）
    'rm -rf dir',                    // 也是 rm
    'cp a.txt b.txt',
    'cp -r src dest',
    'mv a.txt b.txt',
    'chmod 755 file',
    'chown user file',
    'git add .',
    'git commit -m "x"',
    'git push',
    'git pull',
    'git merge feature',
    'git rebase main',
    'git checkout -b new',
    'git reset --hard',
    'git stash',
    'npm install lodash',
    'npm i lodash',
    'npm publish',
    'yarn add express',
    'pnpm install',
    'pip install flask',
    'pip3 install flask',
    'echo hello > file.txt',         // 重定向写
    'echo x >> log.txt',             // 追加写
    'cat input | tee output',
    'sed -i "s/a/b/g" file',
    'sed --in-place "s/a/b/" file',
    'perl -i -pe "s/a/b/" file',
    'truncate -s 0 file',
  ];

  for (const cmd of writeCommands) {
    it(`检出写命令: "${cmd}"`, () => {
      expect(isWriteBash(cmd), `应识别为写命令: ${cmd}`).toBe(true);
    });
  }

  // 不应被检出的只读命令
  const readCommands = [
    'ls -la',
    'ls',
    'cat file.txt',
    'grep -r foo .',
    'find . -name "*.ts"',
    'echo hello',                    // 无重定向，纯输出
    'git status',
    'git log --oneline',
    'git diff',
    'git diff --cached',
    'pwd',
    'ps aux',
    'node --version',
    'npm --version',                 // 不是 npm install
    'cat a | grep x',
    'head -n 10 file',
    'tail -f log',
    'wc -l file',
    'stat file',
  ];

  for (const cmd of readCommands) {
    it(`不误报只读命令: "${cmd}"`, () => {
      expect(isWriteBash(cmd), `不应识别为写命令: ${cmd}`).toBe(false);
    });
  }
});

describe('isDangerousBash 与 isWriteBash 区分', () => {
  it('危险命令仍由 isDangerousBash 检测（不依赖 isWriteBash）', () => {
    expect(isDangerousBash('sudo rm /etc/passwd')).toBe(true);
    expect(isDangerousBash('rm -rf /')).toBe(true);
    expect(isDangerousBash('mkfs /dev/sda')).toBe(true);
  });

  it('部分写命令也危险（双重检出）', () => {
    // rm -rf 既危险也是写
    expect(isDangerousBash('rm -rf foo')).toBe(true);
    expect(isWriteBash('rm -rf foo')).toBe(true);
  });

  it('部分写命令不危险（仅 isWriteBash 检出）', () => {
    expect(isDangerousBash('mkdir foo')).toBe(false);
    expect(isWriteBash('mkdir foo')).toBe(true);
    expect(isDangerousBash('git commit -m x')).toBe(false);
    expect(isWriteBash('git commit -m x')).toBe(true);
  });
});
