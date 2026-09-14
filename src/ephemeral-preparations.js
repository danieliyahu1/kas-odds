// In-memory, expiring store for preparations that carry reveal preimages.
//
// A prepared reveal transaction embeds the choice and nonce in its signature
// script, so persisting it would write the commit-reveal secret to disk before
// broadcast. Reveal preparations therefore live only in process memory with a
// short TTL; losing them on restart only costs the client a re-prepare.
export class EphemeralPreparations {
  constructor({ ttlMs = 900_000, maxEntries = 1000, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = new Map();
  }

  save(record) {
    this.#sweep();
    this.entries.delete(record.preparedHash);
    this.entries.set(record.preparedHash, { record, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
  }

  load(preparedHash) {
    this.#sweep();
    const entry = this.entries.get(preparedHash);
    return entry ? structuredClone(entry.record) : null;
  }

  delete(preparedHash) {
    this.entries.delete(preparedHash);
  }

  deleteForGame(gameId) {
    for (const [preparedHash, entry] of this.entries) {
      if (entry.record.gameId === gameId) this.entries.delete(preparedHash);
    }
  }

  size() {
    this.#sweep();
    return this.entries.size;
  }

  #sweep() {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
  }
}
