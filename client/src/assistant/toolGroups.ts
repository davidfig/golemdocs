// The server describes some tools as groups with an `action` ("comments" with action "reply") to
// keep the list the model reads short. The page runs the single tools they stand for; this turns
// a call to a group into a call to one of those, so everything after it (progress notes, undo,
// the implementations) only knows the single tools. Keep in step with server/src/assistantTools.ts.

/** Each group's actions and the single tool each runs. */
export const TOOL_GROUPS: Record<string, Record<string, string>> = {
  other_documents: { list: 'list_documents', search: 'search_documents', read: 'read_other_document' },
  edit_paragraph: { replace: 'replace_paragraph', insert: 'insert_paragraph', delete: 'delete_paragraph', style: 'set_style' },
  link: { set: 'insert_link', remove: 'remove_link' },
  comments: { list: 'list_comments', add: 'add_comment', edit: 'edit_comment', reply: 'reply_comment', resolve: 'resolve_comment', delete: 'delete_comment' },
  properties: { get: 'get_properties', set: 'set_properties' },
  history: { undo: 'undo', redo: 'redo' },
  pdf_read: { page: 'read_pdf_page', find: 'find_pdf_text', fields: 'list_pdf_fields' },
  pdf_edit: { markup: 'pdf_markup', edit_text: 'pdf_edit_text', add_text: 'pdf_add_text', add_shape: 'pdf_add_shape', page: 'pdf_page', fill_field: 'fill_pdf_field' },
  document: { info: 'get_document_info', count_words: 'count_words', rename: 'rename_document', convert: 'convert_document', download: 'download_document', print: 'print_document' },
  files: { list: 'list_files', open: 'open_file', new: 'new_document', move: 'move_files', delete: 'delete_files', trash: 'list_trash', restore: 'restore_from_trash', download_all: 'download_all' },
  versions: { list: 'list_versions', save: 'save_version', restore: 'restore_version' },
  folders: { create: 'create_folders', rename: 'rename_folders' },
  text_pictures: { select: 'select_text_picture', delete: 'delete_text_picture', resize: 'resize_text_picture', move: 'move_text_picture', edit: 'edit_text_picture' },
  text_drawings: { list: 'list_text_drawings', insert: 'insert_text_drawing', open: 'open_text_drawing', close: 'close_text_drawing' },
  collaboration: { status: 'collaboration_status', take_over: 'take_over_editing' },
  text_file: { info: 'text_file_info', read: 'text_file_read', find: 'text_file_find', replace: 'text_file_replace', edit_lines: 'text_file_edit_lines', insert_lines: 'text_file_insert_lines', delete_lines: 'text_file_delete_lines', undo: 'text_file_undo', redo: 'text_file_redo' },
};

export type Expanded = { name: string; arguments: string } | { error: string };

/** The single tool, and its arguments as JSON, that a call to `name` stands for. Tools that are not groups pass through. */
export function expandTool(name: string, argumentsJson: string): Expanded {
  const actions = Object.hasOwn(TOOL_GROUPS, name) ? TOOL_GROUPS[name] : undefined;
  const isBreak = name === 'insert_break';
  if (!actions && !isBreak) return { name, arguments: argumentsJson };
  let args: unknown;
  try {
    args = argumentsJson.trim() ? JSON.parse(argumentsJson) : {};
  } catch {
    return { error: 'the arguments were not valid JSON.' };
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return { error: 'the arguments must be an object.' };
  const { action, ...rest } = args as Record<string, unknown>;
  // A horizontal rule is a kind of break to the model, its own command to the page.
  if (isBreak) return rest.type === 'rule' ? { name: 'insert_horizontal_rule', arguments: JSON.stringify({ ...rest, type: undefined }) } : { name, arguments: argumentsJson };
  const options = Object.keys(actions!);
  if (typeof action !== 'string' || !Object.hasOwn(actions!, action)) return { error: `\`action\` must be one of: ${options.join(', ')}.` };
  return { name: actions![action], arguments: JSON.stringify(rest) };
}
