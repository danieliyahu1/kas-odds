// Anonymous user feedback delivery.
//
// The browser sends only a message. The server validates it, durably writes it
// to a spill queue before anything can fail, forwards it to a private Telegram
// chat via `sendMessage`, and silently retries queued entries until they land.
// A Telegram outage therefore never loses feedback: the entry is stored first
// and sent when the bot is reachable again. The bot token and chat id come from
// the environment and never reach the browser, and the feedback text itself is
// never logged.
//
// Telegram is deliberately invisible to the user: from their point of view the
// app accepts "a bug, an idea, or something that felt confusing" and thanks
// them. If Telegram is not configured the feedback is still stored in the spill
// queue and delivered once the bot is configured, and a `feedback_delivery_disabled`
// warning is logged so the missing bot is noticed without breaking the app.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { ProtocolError } from './protocol.js';
import { dirname } from 'node:path';

export const FEEDBACK_MAX_MESSAGE = 1500;

export function validateFeedback(input = {}) {
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (!message) throw new ProtocolError('INVALID_FEEDBACK', 'Feedback message is required');
  if (message.length > FEEDBACK_MAX_MESSAGE) {
    throw new ProtocolError('FEEDBACK_TOO_LONG', `Feedback must be at most ${FEEDBACK_MAX_MESSAGE} characters`);
  }
  return { message };
}

export function formatFeedbackMessage(entry) {
  return [`New Even/Odd feedback:`, '', entry.message].join('\n');
}

export class TelegramFeedback {
  constructor({ botToken, chatId, fetchImpl = fetch, endpoint } = {}) {
    this.botToken = botToken;
    this.chatId = chatId;
    this.fetchImpl = fetchImpl;
    this.endpoint = endpoint ?? `https://api.telegram.org/bot${botToken}/sendMessage`;
  }

  get enabled() {
    return Boolean(this.botToken) && Boolean(this.chatId);
  }

  async deliver(entry) {
    if (!this.enabled) throw new Error('Telegram feedback is not configured');
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chatId,
        text: formatFeedbackMessage(entry),
        disable_web_page_preview: true,
      }),
    });
    if (!response.ok) throw new Error(`Telegram sendMessage failed with HTTP ${response.status}`);
  }
}

export class FeedbackSpill {
  constructor({ filePath, now = () => new Date() } = {}) {
    if (!filePath) throw new ProtocolError('STORAGE_UNAVAILABLE', 'Feedback spill path is required');
    this.filePath = filePath;
    this.now = now;
    this.entries = [];
    this.loaded = false;
    this.writeQueue = Promise.resolve();
  }

  async add(feedback) {
    return this.#mutate(() => {
      const entry = { id: randomUUID(), receivedAt: this.now().toISOString(), ...feedback };
      this.entries.push(entry);
      return entry;
    });
  }

  async remove(entry) {
    return this.#mutate(() => {
      const next = this.entries.filter((candidate) => candidate.id !== entry.id);
      if (next.length === this.entries.length) return undefined;
      this.entries = next;
      return true;
    }, { persistWhen: (changed) => changed === true });
  }

  // Retries every queued entry once. Entries the handler accepts are removed;
  // failures stay queued for the next drain.
  async drain(handler) {
    return this.#mutate(async () => {
      const remaining = [];
      let changed = false;
      for (const entry of this.entries) {
        try {
          await handler(entry);
          changed = true;
        } catch {
          remaining.push(entry);
        }
      }
      this.entries = remaining;
      return changed;
    }, { persistWhen: Boolean });
  }

  async #load() {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.entries = validateEntries(JSON.parse(raw));
      this.loaded = true;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.entries = [];
        this.loaded = true;
        return;
      }
      if (error instanceof ProtocolError) throw error;
      const code = error instanceof SyntaxError ? 'STORAGE_CORRUPT' : 'STORAGE_UNAVAILABLE';
      throw new ProtocolError(code, `Unable to read feedback spill: ${error.message}`, { cause: error });
    }
  }

  async #persist() {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(this.entries), 'utf8');
      await rename(temporary, this.filePath);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw new ProtocolError('STORAGE_WRITE_FAILED', `Unable to persist feedback spill: ${error.message}`, { cause: error });
    }
  }

  async #mutate(change, { persistWhen = () => true } = {}) {
    const operation = this.writeQueue.then(async () => {
      await this.#load();
      const result = await change();
      if (persistWhen(result)) await this.#persist();
      return structuredClone(result);
    });
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

function validateEntries(value) {
  if (!Array.isArray(value) || value.some((entry) => !entry || typeof entry !== 'object'
    || typeof entry.id !== 'string' || typeof entry.receivedAt !== 'string' || typeof entry.message !== 'string')) {
    throw new ProtocolError('STORAGE_CORRUPT', 'Feedback spill contains an invalid entry list');
  }
  return value;
}

export class FeedbackService {
  constructor({ deliverer, spill, metrics, now = () => new Date(), logger = console } = {}) {
    this.deliverer = deliverer;
    this.spill = spill;
    this.metrics = metrics;
    this.now = now;
    this.logger = logger;
  }

  // Write-ahead: the feedback is durable before anything can fail, so a
  // Telegram outage, a missing bot, or a crash mid-flight never loses it. An
  // entry accepted while the bot is not configured stays queued and is
  // delivered by the next drain once the bot is configured.
  async submit(input) {
    const feedback = validateFeedback(input);
    const entry = await this.spill.add(feedback);
    if (!this.deliverer.enabled) {
      const reason = 'TELEGRAM_FEEDBACK_BOT_TOKEN or TELEGRAM_FEEDBACK_CHAT_ID is not set';
      this.metrics?.recordFeedback({ outcome: 'disabled' });
      this.logger.warn?.('feedback_delivery_disabled', { reason });
      return { accepted: true, queued: true };
    }
    try {
      await this.deliverer.deliver(entry);
      await this.spill.remove(entry);
      this.metrics?.recordFeedback({ outcome: 'delivered' });
      return { accepted: true };
    } catch (error) {
      this.metrics?.recordFeedback({ outcome: 'queued' });
      this.logger.error?.('feedback_delivery_failed', { message: error?.message });
      return { accepted: true, queued: true };
    }
  }

  async drainPending() {
    let drained = 0;
    await this.spill.drain(async (entry) => {
      await this.deliverer.deliver(entry);
      this.metrics?.recordFeedback({ outcome: 'delivered' });
      drained += 1;
    });
    if (drained > 0) this.logger.info?.('feedback_delivered_from_queue', { count: drained });
  }
}
