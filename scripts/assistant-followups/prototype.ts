import { evaluateWorkspaceQuestion, type AssistantReply, type AssistantSchedule } from '@/lib/workspace-assistant';

// Offline rehearsal only. The workspace popup does not import this module.
type Scope = Readonly<{
  schedule: AssistantSchedule;
  canReadInventory: boolean;
  canDraft: boolean;
  readCatalogCount: () => Promise<number | null>;
}>;

const fixtures = {
  'does that include services': 'explain-catalog',
  'what does that include': 'explain-catalog',
  'can you check again': 'refresh-catalog-count',
  'has that number changed': 'refresh-catalog-count',
} as const;

type Phrase = keyof typeof fixtures;
type MockModel = (request: Readonly<{ phrase: Phrase; anchor: 'catalog-count' }>) => Promise<unknown>;
type Reply = AssistantReply | { kind: 'catalog-count'; count: number } | { kind: 'catalog-definition'; message: string };

function fixturePhrase(input: string): Phrase | null {
  if (input.length > 400 || /[\r\n]/.test(input)) return null;
  const text = input.trim().toLowerCase().replace(/[?.!]+$/, '');
  return Object.hasOwn(fixtures, text) ? text as Phrase : null;
}

function isPlan(output: unknown, expected: typeof fixtures[Phrase]): boolean {
  if (output === null || typeof output !== 'object' || Object.getPrototypeOf(output) !== Object.prototype) return false;
  const field = Object.getOwnPropertyDescriptor(output, 'intent');
  return Reflect.ownKeys(output).length === 1 && field?.value === expected;
}

export function createFollowUpRehearsal(
  // The test host supplies a fresh scope object on any identity or permission
  // change. Neither prompts nor model output can supply or select this object.
  getScope: () => Scope | null,
  mockModel: MockModel,
) {
  let anchor: Scope | null = null;
  let version = 0;
  const clarify = (): Reply => ({ kind: 'clarification', message: 'What would you like me to check? Please name the catalog or the exact appointment.' });
  const unavailable = (): Reply => ({ kind: 'unavailable', message: 'Could not verify the current clinic result. Ask again; this does not mean there were no results.' });

  return {
    reset() { version++; anchor = null; },
    async ask(input: string, now: number): Promise<Reply> {
      const turn = ++version;
      const scope = getScope();
      const current = () => version === turn && scope !== null && getScope() === scope;
      const hadAnchor = scope !== null && anchor === scope;
      anchor = null;

      const count = async (): Promise<Reply> => {
        if (!scope?.canReadInventory || !current()) return unavailable();
        try {
          const value = await scope.readCatalogCount();
          if (!current() || typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return unavailable();
          anchor = scope;
          return { kind: 'catalog-count', count: value };
        } catch { return unavailable(); }
      };

      const fast = evaluateWorkspaceQuestion(input, scope?.schedule ?? {
        window: { from: '', through: '' }, availability: 'offline', partial: true, rows: [],
      }, now);
      if (fast.kind === 'inventory-count') return count();
      if (fast.kind === 'tool') return clarify(); // No Worker tools in this rehearsal.
      if (fast.kind === 'daily-briefing') return clarify(); // No briefing reader in this rehearsal.
      if (fast.kind === 'reschedule' && !scope?.canDraft) return unavailable();
      if (fast.kind !== 'clarification') return fast;

      // Exact fictional phrases keep arbitrary free text out of the mock's
      // input. The single anchor represents the last verified catalog topic,
      // never its result, a record, or the transcript.
      const phrase = fixturePhrase(input);
      if (!phrase) return fast;
      if (!hadAnchor || !scope?.canReadInventory || !current()) return clarify();
      try {
        const output = await mockModel({ phrase, anchor: 'catalog-count' });
        if (!current()) return unavailable();
        const expected = fixtures[phrase];
        if (!isPlan(output, expected)) return clarify();
        if (expected === 'refresh-catalog-count') return count();
        anchor = scope;
        return { kind: 'catalog-definition', message: 'Yes, the catalog includes services as well as medicines, supplies, and grooming entries. It counts entries, not stock units.' };
      } catch { return current() ? clarify() : unavailable(); }
    },
  };
}
