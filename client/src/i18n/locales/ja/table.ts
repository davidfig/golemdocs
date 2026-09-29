import type { Messages } from '../../index.ts';

export const table: Partial<Messages> = {
  'table.title': '表の挿入',
  'table.splitTitle': 'セルの分割',
  'table.close': '閉じる',
  'table.columns': '列数：',
  'table.rows': '行数：',
  'table.columnsLabel': '列数',
  'table.rowsLabel': '行数',
  'table.ok': 'OK',
  'table.cancel': 'キャンセル',
  'table.badSize': '行数は 1 から {maxRows}、列数は 1 から {maxColumns} の範囲で指定してください。',
};
