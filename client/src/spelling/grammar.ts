// Grammar checks that need no dictionary: rules for mistakes that are wrong in nearly every
// sentence they appear in. Each one is deliberately narrow (a flagged phrase should almost never be
// correct), because a checker that cries wolf gets switched off. The text is one paragraph; offsets
// are into it.

export interface GrammarIssue {
  start: number;
  end: number;
  /** What is wrong, as a key of the message catalog (`spelling.rule.…`), for the dialog to translate. */
  message: string;
  /** Replacements for the text from `start` to `end`, best first. */
  suggestions: string[];
  /** A stable name, so the user can ignore a kind of issue. */
  rule: string;
}

/** What surrounds a word that stands alone: not part of a longer word, contraction, hyphenation or number. */
const BEFORE = String.raw`(?<![\p{L}\p{N}'’\-])`;
const AFTER = String.raw`(?![\p{L}\p{N}'’\-])`;

/** Words that are correct twice in a row ("that that", "had had"). */
const DOUBLES = new Set(['had', 'that', 'ha', 'bye', 'no', 'so', 'very', 'yes', 'boom', 'knock', 'dum', 'bora', 'go', 'blah', 'tsk', 'chop', 'wah', 'yada']);

/** Words after "a"/"an" whose first letter is a vowel but that sound like they start with a consonant ("a university"). */
const CONSONANT_SOUND = /^(unicorn|unicycle|unif|union|uniqu|unison|unit|univers|unilat|unilin|unicell|us(e|u|i)|util|uten|utop|eu|ewe|one|once|ubiq|uter|uvul|uk)/i;
/** Words that start with a consonant letter but a vowel sound ("an hour"). */
const VOWEL_SOUND = /^(hour|honest|honou?r|heir|hors d)/i;
/** Words starting with h that are said either way ("a hotel", "an historic"): left alone after "an". */
const EITHER = /^(herb|hotel|histor)/i;

const ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'etc', 'vs', 'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'jr', 'sr', 'no', 'nos', 'fig', 'figs', 'approx', 'cf', 'al', 'inc', 'ltd', 'co', 'dept', 'est', 'vol', 'ca', 'p', 'pp', 'ed', 'eds', 'ch', 'sec', 'gen', 'col', 'lt', 'sgt', 'rev', 'hon', 'a.m', 'p.m', 'u.s', 'u.k', 'ph.d', 'm.d',
]);

const flipCase = (original: string, replacement: string) => (original[0] !== original[0].toLowerCase() ? replacement[0].toUpperCase() + replacement.slice(1) : replacement);

/** Phrases that are almost always wrong: [pattern, replacement (with $1…), message, rule name]. */
const PHRASES: [RegExp, string, string, string][] = [
  [new RegExp(`${BEFORE}(should|could|would|must|might)\\s+of${AFTER}`, 'giu'), '$1 have', 'spelling.rule.modalOf', 'modal-of'],
  [new RegExp(`${BEFORE}your\\s+(welcome|going|not|being|doing|getting|coming|making)${AFTER}`, 'giu'), 'you’re $1', 'spelling.rule.youre', 'your-youre'],
  [new RegExp(`${BEFORE}it['’]s\\s+own${AFTER}`, 'giu'), 'its own', 'spelling.rule.itsOwn', 'its-own'],
  [new RegExp(`${BEFORE}its\\s+(a|an|the|not|been|going|okay|ok)${AFTER}`, 'giu'), 'it’s $1', 'spelling.rule.itsIts', 'its-its'],
  [new RegExp(`${BEFORE}their\\s+(is|are|was|were)${AFTER}`, 'giu'), 'there $1', 'spelling.rule.theirThere', 'their-there'],
  [new RegExp(`${BEFORE}who['’]s\\s+(car|house|book|idea|turn|fault|name)${AFTER}`, 'giu'), 'whose $1', 'spelling.rule.whosWhose', 'whos-whose'],
  [
    new RegExp(`${BEFORE}(more|less|better|worse|rather|other|bigger|smaller|larger|faster|slower|higher|lower|greater|easier|harder|older|younger|longer|shorter|stronger|weaker|cheaper)\\s+then${AFTER}`, 'giu'),
    '$1 than',
    'spelling.rule.thenThan',
    'then-than',
  ],
  [new RegExp(`${BEFORE}irregardless${AFTER}`, 'giu'), 'regardless', 'spelling.rule.irregardless', 'irregardless'],
  [new RegExp(`${BEFORE}I\\s+(is|are)${AFTER}`, 'gu'), 'I am', 'spelling.rule.subjectAm', 'subject-verb'],
  [new RegExp(`${BEFORE}(he|she|it)\\s+(are|were|have)${AFTER}`, 'giu'), '$1 %', 'spelling.rule.subjectVerb', 'subject-verb'],
  [new RegExp(`${BEFORE}(we|they|you)\\s+(is|was|has)${AFTER}`, 'giu'), '$1 %', 'spelling.rule.subjectVerb', 'subject-verb'],
];

/** Verb forms for the subject–verb rules: what to say instead. */
const AGREE: Record<string, Record<string, string>> = {
  he: { are: 'is', were: 'was', have: 'has' },
  she: { are: 'is', were: 'was', have: 'has' },
  it: { are: 'is', were: 'was', have: 'has' },
  we: { is: 'are', was: 'were', has: 'have' },
  they: { is: 'are', was: 'were', has: 'have' },
  you: { is: 'are', was: 'were', has: 'have' },
};

/** Whether "a" or "an" belongs before this word, or null when it can't be said. */
function articleFor(word: string): 'a' | 'an' | null {
  // Acronyms and single letters are read by their names, which need a lookup of their own.
  if (word.length < 2 || word === word.toUpperCase() || /^[A-Za-z]-/.test(word)) return null;
  if (EITHER.test(word)) return null;
  if (VOWEL_SOUND.test(word)) return 'an';
  if (CONSONANT_SOUND.test(word)) return 'a';
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

export function checkGrammar(text: string): GrammarIssue[] {
  const issues: GrammarIssue[] = [];
  const add = (start: number, end: number, message: string, suggestions: string[], rule: string) => issues.push({ start, end, message, suggestions, rule });

  // A word twice in a row.
  for (const m of text.matchAll(new RegExp(`${BEFORE}(\\p{L}+)([ \\t]+)\\1${AFTER}`, 'giu'))) {
    if (DOUBLES.has(m[1].toLowerCase())) continue;
    add(m.index, m.index + m[0].length, 'spelling.rule.repeatedWord', [m[1]], 'repeated-word');
  }

  // "a" before a vowel sound, "an" before a consonant sound.
  for (const m of text.matchAll(new RegExp(`${BEFORE}(an?)(\\s+)(\\p{L}[\\p{L}'’\\-]*)`, 'giu'))) {
    const article = m[1].toLowerCase();
    const wanted = articleFor(m[3]);
    if (!wanted || wanted === article) continue;
    add(m.index, m.index + m[1].length, wanted === 'an' ? 'spelling.rule.useAn' : 'spelling.rule.useA', [flipCase(m[1], wanted)], 'a-an');
  }

  // A sentence that starts with a lower-case letter.
  for (const m of text.matchAll(/([.!?])(["')\]”’]*)(\s+)(\p{Ll}[\p{L}'’]*)/gu)) {
    const before = text.slice(0, m.index + 1);
    // An ellipsis, or a closing quote ("Look out!" he said): the sentence goes on.
    if (before.endsWith('..') || /["”’']/.test(m[2])) continue;
    const previous = /(\S+)$/.exec(before)?.[1] ?? '';
    const bare = previous.replace(/^[("'“‘]+|[.!?]+$/g, '').toLowerCase();
    if (/\d/.test(previous) || ABBREVIATIONS.has(bare) || (bare.length === 1 && previous.endsWith('.')) || /\p{Ll}\.\p{L}/u.test(previous)) continue;
    const word = m[4];
    // eBay, iPhone: lower case on purpose.
    if (/^\p{Ll}+\p{Lu}/u.test(word)) continue;
    const start = m.index + m[0].length - word.length;
    add(start, start + word.length, 'spelling.rule.capitalize', [word[0].toUpperCase() + word.slice(1)], 'capitalize');
  }

  // The pronoun "I".
  for (const m of text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}'’.\\-(\\[])i(?![\\p{L}\\p{N}'’.\\-)\\]])`, 'gu'))) {
    add(m.index, m.index + 1, 'spelling.rule.pronounI', ['I'], 'pronoun-i');
  }

  // Two spaces in the middle of a sentence; a space before a comma or full stop.
  for (const m of text.matchAll(/(?<=[^\s.!?:])( {2,})(?=\S)/g)) add(m.index, m.index + m[0].length, 'spelling.rule.extraSpace', [' '], 'extra-space');
  for (const m of text.matchAll(/(?<=\p{L})( +)([,;.!?:])(?=\s|$)/gu)) add(m.index, m.index + m[0].length, 'spelling.rule.spaceBeforePunctuation', [m[2]], 'space-before-punctuation');

  for (const [pattern, replacement, message, rule] of PHRASES) {
    for (const m of text.matchAll(pattern)) {
      let suggestion = replacement.replace(/\$(\d)/g, (_, n: string) => m[Number(n)]);
      if (rule === 'subject-verb' && suggestion.includes('%')) {
        const fixed = AGREE[m[1].toLowerCase()]?.[m[2].toLowerCase()];
        if (!fixed) continue;
        suggestion = `${m[1]} ${fixed}`;
      }
      add(m.index, m.index + m[0].length, message, [flipCase(m[0], suggestion)], rule);
    }
  }

  return issues.sort((a, b) => a.start - b.start || a.end - b.end);
}
