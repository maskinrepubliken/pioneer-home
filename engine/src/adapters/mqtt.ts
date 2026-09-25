/**
 * Real MQTT transport on top of mqtt.js. Subscriptions are remembered and re-applied after reconnects.
 */
import mqtt, { type MqttClient } from 'mqtt';
import type { Logger } from 'pino';
import { topicMatches, type MessageHandler, type Transport } from '../core/transport.js';

export class MqttTransport implements Transport {
  private client: MqttClient;
  private subs: { filter: string; handler: MessageHandler }[] = [];
  private connectCbs: (() => void)[] = [];

  constructor(url: string, log: Logger, opts: { username?: string; password?: string; clientId?: string } = {}) {
    const options: mqtt.IClientOptions = {
      clientId: opts.clientId ?? `pioneer-engine-${Math.random().toString(16).slice(2, 8)}`,
      reconnectPeriod: 5000,
      connectTimeout: 10_000,
      will: { topic: 'home/engine/status', payload: Buffer.from('offline'), qos: 0, retain: true },
    };
    if (opts.username) options.username = opts.username;
    if (opts.password) options.password = opts.password;
    this.client = mqtt.connect(url, options);
    this.client.on('connect', () => {
      log.info({ url }, 'mqtt connected');
      this.client.publish('home/engine/status', 'online', { retain: true });
      for (const s of this.subs) this.client.subscribe(s.filter);
      for (const cb of this.connectCbs) cb();
    });
    this.client.on('reconnect', () => log.warn('mqtt reconnecting'));
    this.client.on('error', (e) => log.error({ err: e }, 'mqtt error'));
    this.client.on('close', () => log.warn('mqtt connection closed'));
    this.client.on('message', (topic, payload) => {
      const text = payload.toString('utf8');
      for (const s of this.subs) {
        if (topicMatches(s.filter, topic)) {
          try {
            s.handler(topic, text);
          } catch (e) {
            log.error({ err: e, topic }, 'message handler failed');
          }
        }
      }
    });
  }

  publish(topic: string, payload: string, opts?: { retain?: boolean }): void {
    this.client.publish(topic, payload, { retain: opts?.retain ?? false, qos: 0 });
  }

  subscribe(topicFilter: string, handler: MessageHandler): void {
    this.subs.push({ filter: topicFilter, handler });
    if (this.client.connected) this.client.subscribe(topicFilter);
  }

  onConnect(cb: () => void): void {
    this.connectCbs.push(cb);
  }

  async close(): Promise<void> {
    this.client.publish('home/engine/status', 'offline', { retain: true });
    await this.client.endAsync();
  }
}
