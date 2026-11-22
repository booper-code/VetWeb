import { exactAssistantObject, parseAssistantToolInput } from '../../lib/assistant-tools.ts';

export const inventoryTool = 'inventory_import_history';
export const csvHistorySelection = 'csv-catalog-history';
const dayMs = 86_400_000;
const offsetMs = 8 * 3_600_000;
const dateAt = millis => new Date(millis).toISOString().slice(0, 10);
const range = (from, through = from) => ({ from, through });
export const rangeKey = ({ from, through }) => `${from}/${through}`;
const stamp = day => Date.parse(`${day}T00:00:00Z`);
const addDays = (day, days) => dateAt(stamp(day) + dayMs * days);
const months = [
  'jan january ene enero', 'feb february pebrero', 'mar march marso', 'apr april abr abril',
  'may mayo', 'jun june hun hunyo', 'jul july hul hulyo', 'aug august ago agosto',
  'sep sept september set setyembre', 'oct october okt oktubre', 'nov november nob nobyembre', 'dec december dis disyembre',
].map(group => group.split(' '));
const weekdays = [
  'sunday linggo', 'monday lunes', 'tuesday martes', 'wednesday miyerkules',
  'thursday huwebes', 'friday biyernes', 'saturday sabado',
].map(group => group.split(' '));

const monthNumber = name => months.findIndex(group => group.includes(name)) + 1;
const dateFromParts = (year, month, date) => `${year}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;

function dayRef(ref, today, sharedYear) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(ref)) return ref;
  if (/^(?:today|ngayon|ngayong araw)$/.test(ref)) return today;
  if (/^(?:yesterday|kahapon)$/.test(ref)) return addDays(today, -1);
  if (/^(?:two days ago|kamakalawa)$/.test(ref)) return addDays(today, -2);
  const weekday = /^(this|last) ([a-z]+)$/.exec(ref);
  if (weekday) {
    const index = weekdays.findIndex(group => group.includes(weekday[2]));
    if (index >= 0) {
      const monday = (new Date(stamp(today)).getUTCDay() + 6) % 7;
      return addDays(today, (index + 6) % 7 - monday - (weekday[1] === 'last' ? 7 : 0));
    }
  }
  const named = /^([a-z]+)\.? (\d{1,2})(?:,? (\d{4}))?$/.exec(ref);
  if (!named) return null;
  const month = monthNumber(named[1]);
  const year = named[3] ?? sharedYear;
  return month && year ? dateFromParts(year, month, named[2]) : null;
}

function dateWindow(raw, now, sharedYear) {
  const today = dateAt(now + offsetMs);
  const text = raw.trim().replace(/^(?:on|for|noong|nung|sa|ng) /, '');
  const monday = (new Date(stamp(today)).getUTCDay() + 6) % 7;
  let candidate;
  if (/^(?:this (?:calendar )?week(?:[- ]to[- ]date| so far)?|ngayong linggo|nitong linggo)$/.test(text)) {
    candidate = range(addDays(today, -monday), today);
  } else if (/^(?:last (?:full |calendar )?week|(?:buong )?nakaraang (?:buong )?linggo)$/.test(text)) {
    candidate = range(addDays(today, -monday - 7), addDays(today, -monday - 1));
  } else if (/^(?:the )?(?:last|past) (?:7|seven) days$/.test(text)) {
    candidate = range(addDays(today, -6), today);
  } else {
    // A trailing year can govern a compact window. Never infer a year from
    // the device clock or silently move a future December into the prior year.
    const compact = /^([a-z]+)\.? (\d{1,2})-(?:([a-z]+)\.? )?(\d{1,2})(?:,? (\d{4}))?$/.exec(text.replace(/^(?:from|mula) /, ''));
    const wholeMonth = /^([a-z]+)\.? (\d{4})$/.exec(text);
    const between = /^(?:from |between |mula(?: noong)? )?(.+?) (?:to|through|until|hanggang|and) (.+)$/.exec(text);
    if (compact) {
      const first = monthNumber(compact[1]), second = compact[3] ? monthNumber(compact[3]) : first;
      const year = compact[5] ?? sharedYear;
      if (year && first && second) candidate = range(dateFromParts(year, first, compact[2]), dateFromParts(year, second, compact[4]));
    } else if (wholeMonth && monthNumber(wholeMonth[1])) {
      const month = monthNumber(wholeMonth[1]), year = Number(wholeMonth[2]);
      candidate = range(dateFromParts(year, month, 1), dateAt(Date.UTC(year, month, 0)));
    } else if (between && (text.startsWith('between ') === / and /.test(text))) {
      candidate = range(dayRef(between[1], today, sharedYear), dayRef(between[2], today, sharedYear));
    } else {
      const day = dayRef(text, today, sharedYear);
      if (day) candidate = range(day);
    }
  }
  return candidate ? parseAssistantToolInput(inventoryTool, candidate, now) : null;
}

const subject = /\b(?:catalog (?:items|rows|entries) (?:imported|brought in|added) (?:via|by|from) csv|(?:inventory |catalog )?(?:items|rows|entries) (?:were )?(?:imported|added) (?:via|by|from) csv|(?:mga )?(?:items?|rows?|records?) (?:ang |(?:na )?)?(?:na-?import|naipasok) (?:mula sa|mula|sa|via) csv|(?:na-?import|naipasok) (?:na )?(?:mga )?(?:items?|rows?) (?:mula sa|mula|sa|via) csv|(?:csv )?(?:catalog |inventory )?(?:items?|rows?|entries) (?:ang |(?:were )?)?(?:imported|na-?import)|(?:tracked )?csv (?:catalog |inventory )?(?:imports?(?: count| tally| total)?|(?:count|tally|total)|(?:items?|rows?|entries)(?: (?:imported|na-?import))?)|(?:bilang ng |count ng )?(?:mga )?(?:na-?import|naipasok) (?:mula sa|mula|sa|via) csv)\b/g;

const scopedReceipt = /\b(?:(?:mga|all) )?(?:receipts?|resibo)(?: were recorded| are on record| came in)?\b/g;
const countLead = /^(?:(?:how many|count(?: the)?|show(?: me)?(?: the)?(?: count of)?|give(?: me)?(?: the)?(?: number of)?|what(?: was| is| were)?(?: the)?|ilang|ilan(?: ba)? ang|bilangin(?: ang)?|bilang ng|ano ang bilang ng|ano ang|i-count(?: ang)?|(?:pa|paki)-count ng) )?@(?: (.+))?$/;
const compareLead = /^(?:compare|ihambing(?: ang)?|paghambingin(?: ang)?|i-compare(?: ang)?)(?: (?:the|ang))? @ (.+)$/;
const compareEllipsis = /^(?:compare|ihambing(?: ang)?|paghambingin(?: ang)?|i-compare(?: ang)?) (.+)$/;
const compareJoiner = / (?:compared (?:to|with)|with|against|versus|vs\.?|and|at|kumpara sa|sa) /g;
const conditionalLead = /^(?:if|kung|kapag) @ (.+?) (?:is |was |were |are |ay )?(?:below|under|fewer than|less than|mas mababa sa) (\d{1,5})(?: (?:rows|items))?(?:, ?| then | ay | saka )(?:then |also |ay )?(?:check din|check|include|look up|count|tingnan(?: din)?(?: ang)?|isama(?: rin)?(?: ang)?|i-check(?: din)?)(?: @)? (.+?)(?: too| as well| din| rin)?$/;
const fallbackCount = /^(?:tally(?: up)?(?: the)?|suriin(?: ang)?|pa-check(?: ng)?|check(?: the)?(?: tally for)?) @ (.+)$/;
const fallbackCompare = /^@ (.+?) (?:vs\.?|versus|kumpara sa|compared (?:to|with)) (.+)$/;
const fallbackConditional = /^@ (.+?)(?:;|,) (?:if|kung|kapag) (?:below|under|fewer than|less than|mas mababa sa) (\d{1,5})(?:, ?| then | ay | saka )(?:then )?(?:check|include|tingnan(?: din)?(?: ang)?|isama(?: rin)?(?: ang)?)(?: @)? (.+?)(?: too| as well| din| rin)?$/;
const scopedConditional = /^if (.+?) (?:has |is |had )?(?:below|under|fewer than|less than) (\d{1,5})(?: @)?(?:, ?| then )(?:also |then )?(?:count|check|include)(?: @)? (.+)$/;
const scopedConditionalTl = /^kung mas mababa sa (\d{1,5}) ang @ (.+?)(?:, ?| ay )(?:bilangin|tingnan|isama)(?: din)?(?: ang)?(?: @)? (.+)$/;

const clarified = Object.freeze({ kind: 'clarify' });
const unsupported = Object.freeze({ kind: 'unsupported' });
const intents = Object.freeze({
  tally: 'count', contrast: 'compare', below: 'conditional',
});

function comparisonWindows(text, now) {
  const pairs = [...text.matchAll(compareJoiner)].map(match => {
    const parts = [text.slice(0, match.index), text.slice(match.index + match[0].length).replace(/^@ /, '')];
    return parseWindows(parts, now);
  }).filter(([first, second]) => first && second);
  return pairs.length === 1 ? pairs[0] : [];
}

function parseWindows(parts, now) {
  // Only look inside grammar-matched date slots: a predicate threshold of
  // 2026 must never accidentally supply a missing calendar year.
  const years = new Set(parts.flatMap(part => [...part.matchAll(/(?:^|[ ,])(\d{4})(?=$|[ ,])/g)].map(match => match[1])));
  const sharedYear = years.size === 1 ? [...years][0] : undefined;
  return parts.map(part => dateWindow(part, now, sharedYear));
}

export function scopeFictionalInventory(prompt, now, selection) {
  if (typeof prompt !== 'string' || prompt.length > 400 || !Number.isFinite(now) || !Number.isFinite(new Date(now + offsetMs).getTime()) ||
    !/^[\p{L}\p{M}\p{N} \t?.!,;’'–—-]+$/u.test(prompt) || !prompt.trim()) return clarified;
  const scoped = selection === csvHistorySelection;
  let text = prompt.normalize('NFC').trim().toLowerCase().replace(/[’]/g, "'")
    .replace(/[–—]/g, '-').replace(/\s+/g, ' ').replace(/[?!]$/, '').replace(/\.$/, '').trim();
  // Unknown/mixed material never becomes context: after subject substitution a
  // whole grammar and every date atom must match, not merely contain keywords.
  if (/^(?:delete|book|email|i-email|ilagay sa calendar|show (?:total )?revenue)\b/.test(text)) return unsupported;
  const explicit = /\bcsv\b/.test(text);
  if (!explicit && !scoped) {
    return /\b(?:import|imported|imports|na-?import|inventory|stock|items|tally|compare|paghambingin|ihambing|receipts?|resibo)\b/.test(text) ? clarified : unsupported;
  }
  if (compareEllipsis.test(text)) {
    text = text.replace(/\. (?:which is higher(?:, and by how much)?|first minus second(?:, please)?|ano ang pagkakaiba)$/, '');
  } else if (/^(?:if|kung|kapag) /.test(text)) {
    text = text.replace(/; (?:otherwise stop|kung hindi, tumigil)$/, '');
  }
  const explicitWords = text.replace(subject, '@');
  const words = scoped ? explicitWords.replace(scopedReceipt, '@') : explicitWords;
  if (!explicit && !words.includes('@') && !/^(?:if|kung|kapag|compare|ihambing|paghambingin)\b/.test(words)) return unsupported;
  const rules = [
    ['direct', 'conditional', conditionalLead],
    ['direct', 'compare', compareLead],
    ['direct', 'count', countLead],
    ['fallback', 'conditional', fallbackConditional],
    ['fallback', 'compare', fallbackCompare],
    ['fallback', 'count', fallbackCount],
    ...(scoped ? [
      ['fallback', 'compare', compareEllipsis],
      ['fallback', 'conditional', scopedConditional],
      ['fallback', 'conditional', scopedConditionalTl],
    ] : []),
  ];
  for (const [kind, task, pattern] of rules) {
    const match = pattern.exec(words);
    if (!match) continue;
    const namedFirst = pattern === scopedConditionalTl ? match[2] : match[1];
    if (!namedFirst && !explicit) continue;
    const [first, second] = (pattern === compareLead || pattern === compareEllipsis) ? comparisonWindows(namedFirst, now)
      : parseWindows(task === 'count' ? [namedFirst ?? 'last 7 days'] : [namedFirst, match[task === 'compare' ? 2 : 3]], now);
    const threshold = task === 'conditional' ? Number(match[pattern === scopedConditionalTl ? 1 : 2]) : null;
    if (!first || (task !== 'count' && !second) || (threshold !== null && (threshold < 1 || threshold > 10_000))) continue;
    return {
      kind,
      plan: { kind: 'plan', tool: inventoryTool, task, first, ...(second && { second }), ...(threshold !== null && { threshold }) },
    };
  }
  return clarified;
}

export function plannerContext(plan) {
  const wording = Object.keys(intents).find(key => intents[key] === plan.task);
  return {
    wording,
    windows: [plan.first, plan.second].filter(Boolean).map(({ from, through }) => ({ from, through })),
    ...(plan.task === 'conditional' && { limit: plan.threshold }),
  };
}

export function acceptScopedPlan(value, permitted, now) {
  if (exactAssistantObject(value, ['kind']) && value.kind === 'clarify') return null;
  const keys = ['kind', 'tool', 'task', 'first'];
  if (permitted.task !== 'count') keys.push('second');
  if (permitted.task === 'conditional') keys.push('threshold');
  if (!exactAssistantObject(value, keys) || value.kind !== 'plan' || value.tool !== inventoryTool || value.task !== permitted.task ||
    (permitted.task === 'conditional' && value.threshold !== permitted.threshold)) return null;
  for (const key of permitted.task === 'count' ? ['first'] : ['first', 'second']) {
    if (!parseAssistantToolInput(inventoryTool, value[key], now) || rangeKey(value[key]) !== rangeKey(permitted[key])) return null;
  }
  // Execute our own snapshot even when a returned command matches it exactly.
  return permitted;
}

// Exercise the planner protocol without an API call, model output or answer key.
export async function scriptedPhase2BPlanner({ wording, windows, limit }) {
  const task = intents[wording];
  return { command: {
    kind: 'plan', task, tool: inventoryTool, first: windows[0],
    ...(task !== 'count' && { second: windows[1] }),
    ...(task === 'conditional' && { threshold: limit }),
  } };
}
