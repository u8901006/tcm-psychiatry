import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ESEARCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const EFETCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";
const HEADERS = { "User-Agent": "TCMPsychiatryBot/1.0 (research aggregator)" };

const SEARCH_QUERIES = [
  `("Traditional Chinese Medicine"[tiab] OR "Chinese medicine"[tiab] OR "Chinese herbal medicine"[tiab] OR acupuncture[tiab] OR electroacupuncture[tiab] OR qigong[tiab] OR "tai chi"[tiab]) AND (depression[tiab] OR anxiety[tiab] OR insomnia[tiab] OR "mental health"[tiab] OR psychiatry[tiab] OR PTSD[tiab] OR schizophrenia[tiab] OR bipolar[tiab] OR dementia[tiab] OR cognition[tiab])`,
  `("Chinese herbal medicine"[tiab] OR "Chinese herbal formula"[tiab] OR "Drugs, Chinese Herbal"[Mesh]) AND ("Depressive Disorder"[Mesh] OR depression[tiab] OR "major depressive disorder"[tiab] OR antidepressant[tiab])`,
  `("Acupuncture Therapy"[Mesh] OR acupuncture[tiab] OR electroacupuncture[tiab] OR acupressure[tiab] OR auricular[tiab]) AND ("Anxiety Disorders"[Mesh] OR anxiety[tiab] OR "generalized anxiety"[tiab] OR "panic disorder"[tiab])`,
  `("Traditional Chinese Medicine"[tiab] OR "Chinese herbal medicine"[tiab] OR acupuncture[tiab] OR acupressure[tiab] OR qigong[tiab] OR "tai chi"[tiab]) AND ("Sleep Initiation and Maintenance Disorders"[Mesh] OR insomnia[tiab] OR "sleep quality"[tiab] OR "sleep disorder"[tiab])`,
  `(qigong[tiab] OR "Qi Gong"[tiab] OR "Tai Chi"[tiab] OR Taiji[tiab] OR Baduanjin[tiab] OR "mind-body exercise"[tiab]) AND ("mental health"[tiab] OR depression[tiab] OR anxiety[tiab] OR stress[tiab] OR insomnia[tiab] OR cognition[tiab])`,
  `("Traditional Chinese Medicine"[tiab] OR "Chinese herbal medicine"[tiab] OR acupuncture[tiab] OR electroacupuncture[tiab]) AND (depression[tiab] OR anxiety[tiab] OR insomnia[tiab] OR PTSD[tiab]) AND (neuroinflammation[tiab] OR cytokine*[tiab] OR "HPA axis"[tiab] OR cortisol[tiab] OR BDNF[tiab] OR "gut microbiota"[tiab] OR "gut-brain axis"[tiab])`,
  `("syndrome differentiation"[tiab] OR "pattern differentiation"[tiab] OR "TCM syndrome"[tiab] OR "liver qi stagnation"[tiab] OR "heart spleen deficiency"[tiab]) AND (depression[tiab] OR anxiety[tiab] OR insomnia[tiab] OR psychiatry[tiab] OR "mental disorder"[tiab])`,
  `("Traditional Chinese Medicine"[tiab] OR acupuncture[tiab] OR "Chinese herbal medicine"[tiab]) AND ("Stress Disorders, Post-Traumatic"[Mesh] OR PTSD[tiab] OR trauma[tiab] OR "post-traumatic stress"[tiab])`,
];

function getDateRange(days) {
  const now = new Date();
  const past = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const fmt = (d) =>
    `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
  return `"${fmt(past)}"[Date - Publication] : "3000"[Date - Publication]`;
}

function loadSummarizedPmids() {
  const p = join(process.cwd(), "summarized-pmids.json");
  if (existsSync(p)) {
    try {
      const data = JSON.parse(readFileSync(p, "utf-8"));
      return new Set(data.pmids || []);
    } catch {
      return new Set();
    }
  }
  return new Set();
}

async function searchPmids(query, retmax = 60) {
  const url = new URL(ESEARCH_URL);
  url.searchParams.set("db", "pubmed");
  url.searchParams.set("term", query);
  url.searchParams.set("retmax", String(retmax));
  url.searchParams.set("sort", "date");
  url.searchParams.set("retmode", "json");
  try {
    const resp = await fetch(url.toString(), { headers: HEADERS, signal: AbortSignal.timeout(30000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return data?.esearchresult?.idlist || [];
  } catch (e) {
    console.error(`[WARN] Search failed: ${e.message}`);
    return [];
  }
}

function extractText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  if (!m) return "";
  return m[1].replace(/<[^>]+>/g, "").trim();
}

function extractAbstract(articleXml) {
  const parts = [];
  const re = /<AbstractText\s+Label="([^"]*)"[^>]*>([\s\S]*?)<\/AbstractText>/g;
  let m;
  while ((m = re.exec(articleXml)) !== null) {
    const text = m[2].replace(/<[^>]+>/g, "").trim();
    if (text) parts.push(`${m[1]}: ${text}`);
  }
  if (parts.length > 0) return parts.join(" ").slice(0, 2000);
  const plain = extractText(articleXml, "Abstract");
  return plain ? plain.slice(0, 2000) : "";
}

function extractKeywords(articleXml) {
  const kws = [];
  const re = /<Keyword>([^<]+)<\/Keyword>/g;
  let m;
  while ((m = re.exec(articleXml)) !== null) {
    kws.push(m[1].trim());
  }
  return kws;
}

function extractPmid(articleXml) {
  const m = articleXml.match(/<PMID[^>]*>(\d+)<\/PMID>/);
  return m ? m[1] : "";
}

function extractPubDate(articleXml) {
  const y = extractText(articleXml, "Year");
  const mo = extractText(articleXml, "Month");
  const d = extractText(articleXml, "Day");
  return [y, mo, d].filter(Boolean).join(" ");
}

function parseArticles(xml) {
  const articles = [];
  const blocks = xml.split(/<PubmedArticle>/).slice(1);
  for (const block of blocks) {
    const end = block.indexOf("</PubmedArticle>");
    const art = end > 0 ? block.slice(0, end) : block;
    const title = extractText(art, "ArticleTitle");
    if (!title) continue;
    const journalEl = art.match(/<Journal>[\s\S]*?<Title>([^<]+)<\/Title>/);
    const journal = journalEl ? journalEl[1].trim() : "";
    const pmid = extractPmid(art);
    articles.push({
      pmid,
      title,
      journal,
      date: extractPubDate(art),
      abstract: extractAbstract(art),
      url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : "",
      keywords: extractKeywords(art),
    });
  }
  return articles;
}

async function fetchDetails(pmids) {
  if (!pmids.length) return [];
  const url = new URL(EFETCH_URL);
  url.searchParams.set("db", "pubmed");
  url.searchParams.set("id", pmids.join(","));
  url.searchParams.set("retmode", "xml");
  try {
    const resp = await fetch(url.toString(), { headers: HEADERS, signal: AbortSignal.timeout(60000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const xml = await resp.text();
    return parseArticles(xml);
  } catch (e) {
    console.error(`[ERROR] Fetch details failed: ${e.message}`);
    return [];
  }
}

async function main() {
  const targetDate = process.env.TARGET_DATE || new Date().toISOString().slice(0, 10);
  const lookback = parseInt(process.env.LOOKBACK_DAYS || "7", 10);
  const maxPapers = parseInt(process.env.MAX_PAPERS || "60", 10);

  const dateFilter = getDateRange(lookback);
  const summarized = loadSummarizedPmids();
  console.error(`[INFO] Already summarized: ${summarized.size} PMIDs`);

  const allPmids = new Set();
  for (const q of SEARCH_QUERIES) {
    const fullQuery = `(${q}) AND ${dateFilter}`;
    const ids = await searchPmids(fullQuery, Math.ceil(maxPapers / SEARCH_QUERIES.length));
    for (const id of ids) allPmids.add(id);
    await new Promise((r) => setTimeout(r, 400));
  }

  const newPmids = [...allPmids].filter((id) => !summarized.has(id));
  console.error(`[INFO] Found ${allPmids.size} total, ${newPmids.length} new PMIDs`);

  const toFetch = newPmids.slice(0, maxPapers);
  const papers = await fetchDetails(toFetch);
  console.error(`[INFO] Fetched details for ${papers.length} papers`);

  const output = {
    date: targetDate,
    count: papers.length,
    papers,
  };

  writeFileSync("papers.json", JSON.stringify(output, null, 2));
  console.error(`[INFO] Saved to papers.json`);
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
