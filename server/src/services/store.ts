import { MongoClient, MongoServerError, type Collection, type Db } from "mongodb";

export type Role = "user" | "model";

export type Message = {
  id: string;
  role: Role;
  text: string;
  createdAt: Date;
};

// Everything the API needs from storage. MongoStore is used in production;
// MemoryStore backs the tests so they need no database.
export interface ChatStore {
  history(userId: string, limit: number): Promise<Message[]>;
  // Saves a question and its answer together, so a failed reply leaves no half turn.
  appendTurn(userId: string, question: string, answer: string): Promise<Message[]>;
  clear(userId: string): Promise<number>;
  // Counts one use of `key` for `day`. Returns false, without counting, once `limit` is reached.
  consume(key: string, day: string, limit: number): Promise<boolean>;
  refund(key: string, day: string): Promise<void>;
}

type MessageDoc = { userId: string; role: Role; text: string; createdAt: Date };
type UsageDoc = { _id: string; count: number; expireAt: Date };

const toMessage = (doc: MessageDoc & { _id: { toString(): string } }): Message => ({
  id: doc._id.toString(),
  role: doc.role,
  text: doc.text,
  createdAt: doc.createdAt,
});

export class MongoStore implements ChatStore {
  private messages: Collection<MessageDoc>;
  private usage: Collection<UsageDoc>;

  private constructor(
    private client: MongoClient,
    db: Db,
  ) {
    this.messages = db.collection<MessageDoc>("messages");
    this.usage = db.collection<UsageDoc>("usage");
  }

  static async connect(uri: string, dbName: string): Promise<MongoStore> {
    const client = await MongoClient.connect(uri);
    const store = new MongoStore(client, client.db(dbName));
    await store.messages.createIndex({ userId: 1, createdAt: -1 });
    // Usage counters only matter for a day; Mongo deletes them after expireAt.
    await store.usage.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
    return store;
  }

  async history(userId: string, limit: number): Promise<Message[]> {
    const docs = await this.messages.find({ userId }).sort({ createdAt: -1, _id: -1 }).limit(limit).toArray();
    return docs.reverse().map(toMessage);
  }

  async appendTurn(userId: string, question: string, answer: string): Promise<Message[]> {
    const now = Date.now();
    const docs: MessageDoc[] = [
      { userId, role: "user", text: question, createdAt: new Date(now) },
      { userId, role: "model", text: answer, createdAt: new Date(now + 1) },
    ];
    const result = await this.messages.insertMany(docs);
    return docs.map((doc, i) => toMessage({ ...doc, _id: result.insertedIds[i]! }));
  }

  async clear(userId: string): Promise<number> {
    const result = await this.messages.deleteMany({ userId });
    return result.deletedCount;
  }

  async consume(key: string, day: string, limit: number): Promise<boolean> {
    const expireAt = new Date(`${day}T00:00:00Z`);
    expireAt.setUTCDate(expireAt.getUTCDate() + 2);
    try {
      // The filter only matches while under the limit. At the limit it doesn't match,
      // the upsert tries to insert a second document with the same _id, and Mongo
      // rejects it with a duplicate key error: the check and the increment are one step.
      await this.usage.updateOne(
        { _id: `${key}:${day}`, count: { $lt: limit } },
        { $inc: { count: 1 }, $setOnInsert: { expireAt } },
        { upsert: true },
      );
      return true;
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) return false;
      throw err;
    }
  }

  async refund(key: string, day: string): Promise<void> {
    await this.usage.updateOne({ _id: `${key}:${day}`, count: { $gt: 0 } }, { $inc: { count: -1 } });
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export class MemoryStore implements ChatStore {
  private rows: (MessageDoc & { id: string })[] = [];
  private counts = new Map<string, number>();
  private nextId = 1;

  async history(userId: string, limit: number): Promise<Message[]> {
    return this.rows
      .filter((r) => r.userId === userId)
      .slice(-limit)
      .map(({ id, role, text, createdAt }) => ({ id, role, text, createdAt }));
  }

  async appendTurn(userId: string, question: string, answer: string): Promise<Message[]> {
    const now = Date.now();
    const added = [
      { id: String(this.nextId++), userId, role: "user" as const, text: question, createdAt: new Date(now) },
      { id: String(this.nextId++), userId, role: "model" as const, text: answer, createdAt: new Date(now + 1) },
    ];
    this.rows.push(...added);
    return added.map(({ id, role, text, createdAt }) => ({ id, role, text, createdAt }));
  }

  async clear(userId: string): Promise<number> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.userId !== userId);
    return before - this.rows.length;
  }

  async consume(key: string, day: string, limit: number): Promise<boolean> {
    const id = `${key}:${day}`;
    const count = this.counts.get(id) ?? 0;
    if (count >= limit) return false;
    this.counts.set(id, count + 1);
    return true;
  }

  async refund(key: string, day: string): Promise<void> {
    const id = `${key}:${day}`;
    this.counts.set(id, Math.max(0, (this.counts.get(id) ?? 0) - 1));
  }
}
