// One-off import of chats saved by the old frontend (the `appinfos` collection, one document
// per user with a `qna` array) into this backend's `messages` collection.
// Usage: MONGODB_URI=... LEGACY_DB=<frontend db name> pnpm tsx scripts/import-legacy.ts [--dry-run]
import "dotenv/config";
import { MongoClient, type ObjectId } from "mongodb";

type LegacyDoc = { userId: ObjectId; qna: { question: string; answer: string; timeStamp?: Date }[] };

const uri = process.env.MONGODB_URI;
const legacyDb = process.env.LEGACY_DB;
const targetDb = process.env.MONGODB_DB ?? "chatbot";
const dryRun = process.argv.includes("--dry-run");

if (!uri || !legacyDb) {
  console.error("Set MONGODB_URI and LEGACY_DB (the database the Next.js app writes to).");
  process.exit(1);
}

// The old upstream API returned JSON like {"response": "..."}, and failed requests were
// saved as "Error: ...". Keep the text of real answers and skip the failures.
function answerText(raw: string): string | null {
  if (raw.startsWith("Error:")) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.response === "string") return parsed.response;
    if (typeof parsed?.reply === "string") return parsed.reply;
  } catch {
    // plain text answer
  }
  return raw;
}

const client = await MongoClient.connect(uri);
try {
  const legacy = client.db(legacyDb).collection<LegacyDoc>("appinfos");
  const messages = client.db(targetDb).collection("messages");

  let users = 0;
  let turns = 0;
  let skipped = 0;
  for await (const doc of legacy.find()) {
    const userId = doc.userId.toString();
    // Re-running the script must not duplicate anything.
    if (await messages.countDocuments({ userId }, { limit: 1 })) continue;

    const rows = [];
    for (const item of doc.qna) {
      const answer = answerText(item.answer);
      if (!answer) {
        skipped++;
        continue;
      }
      const at = new Date(item.timeStamp ?? Date.now()).getTime();
      rows.push(
        { userId, role: "user", text: item.question, createdAt: new Date(at) },
        { userId, role: "model", text: answer, createdAt: new Date(at + 1) },
      );
      turns++;
    }
    if (rows.length && !dryRun) await messages.insertMany(rows);
    users++;
  }
  console.log(`${dryRun ? "Would import" : "Imported"} ${turns} turns for ${users} users; skipped ${skipped} failed answers.`);
} finally {
  await client.close();
}
