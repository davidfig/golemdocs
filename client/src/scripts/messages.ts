// The script package's messages in the person's language (client/src/i18n/en/scripts.ts): set before each script is read or
// run, so a language changed since is used.

import { SCRIPT_MESSAGES, setScriptMessages } from '@golemdocs/script/messages';
import type { ScriptMessageKey, ScriptMessages } from '@golemdocs/script/messages';
import { t } from '../i18n/index.ts';
import type { MessageKey } from '../i18n/index.ts';

export function useScriptMessages(): void {
  setScriptMessages(Object.fromEntries((Object.keys(SCRIPT_MESSAGES) as ScriptMessageKey[]).map((key) => [key, t(`scripts.error.${key}` as MessageKey)])) as ScriptMessages);
}
