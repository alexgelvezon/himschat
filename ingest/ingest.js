import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";
import pdfParse from "pdf-parse";
import OpenAI from "openai";

dotenv.config();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function chunkText(text, maxLen = 1200, overlap = 200) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(i + maxLen, text.length);
    const slice = text.slice(i, end);
    chunks.push(slice.trim());
    i = end - overlap;
    if (i < 0) i = 0;
  }
  return chunks.filter(Boolean);
}

async function readPdfText(filePath) {
  const data = await fs.readFile(filePath);
  const pdf = await pdfParse(data);
  return pdf.text.replace(/\s+\n/g, "\n").trim();
}

async function embedBatch(texts) {
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: texts,
  });
  return res.data.map(d => d.embedding);
}

async function* batchify(arr, size = 64) {
  for (let i = 0; i < arr.length; i += size) {
    yield arr.slice(i, i + size);
  }
}

const PDF_DIR = new URL("./pdfs/", import.meta.url).pathname; // put PDFs here
const OUT_FILE = new URL("./kv_bulk.json", import.meta.url).pathname;

const files = (await fs.readdir(PDF_DIR)).filter(f => f.toLowerCase().endsWith(".pdf"));
if (!files.length) {
  console.error("No PDFs found in ./ingest/pdfs");
  process.exit(1);
}

const kvItems = [];
for (const file of files) {
  const full = path.join(PDF_DIR, file);
  console.log("Reading:", file);
  const text = await readPdfText(full);
  const docId = path.parse(file).name;
  const chunks = chunkText(text);

  let idx = 0;
  for await (const sub of batchify(chunks, 64)) {
    console.log(`Embeddings: ${docId} [${idx}..${idx + sub.length - 1}]`);
    const embs = await embedBatch(sub);
    for (let i = 0; i < sub.length; i++) {
      const key = `doc:${docId}:chunk:${idx + i}`;
      const value = JSON.stringify({ id: key, docId, text: sub[i], embedding: embs[i] });
      kvItems.push({ key, value });
    }
    idx += sub.length;
  }
}

await fs.writeFile(OUT_FILE, JSON.stringify(kvItems, null, 2));
console.log(`Wrote ${kvItems.length} chunks to ${OUT_FILE}`);
