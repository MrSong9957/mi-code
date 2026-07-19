import { render, Text } from 'ink';
import React from 'react';

const ansiString = '\x1b[32mgreen text\x1b[0m and \x1b[1mbold\x1b[0m';

render(<Text>{ansiString}</Text>, {
  stdout: {
    write: (s: string) => { console.error(JSON.stringify(s)); return true; },
    columns: 80, rows: 24, isTTY: true,
    on: () => false, off: () => false, resize: () => {},
  } as any,
  exitOnCtrlC: false,
  patchConsole: false,
});

setTimeout(() => process.exit(0), 100);
