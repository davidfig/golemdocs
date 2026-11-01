// Runs workbooks through Microsoft Excel on this Mac: Excel opens each, recalculates everything and saves it as .xlsx
// (excel.applescript). Excel is sandboxed, so files go through a folder inside its container, which it may read and write
// without asking. Used to make the oracle's expected values (oracle.ts) and to check that files we write open in Excel.
//
//   pnpm tsx scripts/sheets/excel.ts <in.xlsx> [<out.xlsx>]     (default out: <in>.excel.xlsx)

import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const SANDBOX = path.join(homedir(), 'Library/Containers/com.microsoft.Excel/Data/golemdocs-sheets');
const SCRIPT = path.join(import.meta.dirname, 'excel.applescript');

export const excelInstalled = (): boolean => existsSync('/Applications/Microsoft Excel.app');

/** Has Excel recalculate and save each [input, output] pair. Throws with Excel's message if one fails or Excel hangs (a dialog). */
export async function recalculateInExcel(pairs: [input: string, output: string][]): Promise<void> {
  if (!excelInstalled()) throw new Error('Microsoft Excel is not installed');
  const run = path.join(SANDBOX, `${process.pid}-${Date.now()}`);
  mkdirSync(run, { recursive: true });
  try {
    const args: string[] = [];
    pairs.forEach(([input], i) => {
      const stem = path.basename(input, '.xlsx');
      const inside = path.join(run, `${i}-${stem}.xlsx`);
      copyFileSync(input, inside);
      args.push(inside, path.join(run, `${i}-${stem}.out.xlsx`));
    });
    await promisify(execFile)('osascript', [SCRIPT, ...args], { timeout: 10 * 60_000 });
    pairs.forEach(([, output], i) => {
      mkdirSync(path.dirname(output), { recursive: true });
      copyFileSync(args[i * 2 + 1], output);
    });
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input) throw new Error('usage: excel.ts <in.xlsx> [<out.xlsx>]');
  const target = output ?? input.replace(/\.xlsx$/, '') + '.excel.xlsx';
  await recalculateInExcel([[path.resolve(input), path.resolve(target)]]);
  console.log(target);
}
