/**
 * Message transport abstraction. The real implementation wraps mqtt.js; the fake one records
 * everything published and lets the simulator inject messages and echo device state.
 */

export type MessageHandler = (topic: string, payload: string) => void;

export interface Transport {
  publish(topic: string, payload: string, opts?: { retain?: boolean }): void;
  subscribe(topicFilter: string, handler: MessageHandler): void;
  /** Called after (re)connection so subscribers can re-request retained state. Optional for fakes. */
  onConnect?(cb: () => void): void;
}

export interface PublishedMessage {
  topic: string;
  payload: string;
  retain: boolean;
}

/** MQTT topic filter matching with `+` (single level) and `#` (rest). */
export function topicMatches(filter: string, topic: string): boolean {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    const part = f[i];
    if (part === '#') return true;
    if (i >= t.length) return false;
    if (part !== '+' && part !== t[i]) return false;
  }
  return f.length === t.length;
}

export class FakeTransport implements Transport {
  readonly published: PublishedMessage[] = [];
  private subs: { filter: string; handler: MessageHandler }[] = [];
  private publishHooks: ((msg: PublishedMessage) => void)[] = [];

  publish(topic: string, payload: string, opts?: { retain?: boolean }): void {
    const msg = { topic, payload, retain: opts?.retain ?? false };
    this.published.push(msg);
    for (const hook of this.publishHooks) hook(msg);
  }

  subscribe(topicFilter: string, handler: MessageHandler): void {
    this.subs.push({ filter: topicFilter, handler });
  }

  /** Delivers a message as if it came from the broker. */
  inject(topic: string, payload: string): void {
    for (const s of this.subs) {
      if (topicMatches(s.filter, topic)) s.handler(topic, payload);
    }
  }

  /** Lets the simulator react to outgoing commands (e.g. echo device state back). */
  onPublish(hook: (msg: PublishedMessage) => void): void {
    this.publishHooks.push(hook);
  }

  /** Messages published since the given index (used by scenario steps). */
  since(index: number): PublishedMessage[] {
    return this.published.slice(index);
  }
}
