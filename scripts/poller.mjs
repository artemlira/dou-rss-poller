// Опитує RSS-стрічки з цього комп'ютера (DOU блокує IP Cloudflare Workers)
// і передає знайдені вакансії у Worker, який дедуплікує та шле їх у Telegram.
//
// Конфіг: ~/.dou-jobs-bot.env  (WORKER_URL=..., API_KEY=...)
// Запуск: node scripts/poller.mjs

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fetchFeed } from "../src/rss.ts";

const PAUSE_BETWEEN_FEEDS_MS = 1500;
const MAX_DESCRIPTION_CHARS = 1500;
const MAX_ITEMS = 50;
const MAX_FIELD = 500;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// Логи GitHub Actions у публічному репозиторії видно всім:
// у CI показуємо лише id підписки, не її назву.
function label(sub) {
  return process.env.GITHUB_ACTIONS === "true" ? `sub ${sub.id}` : sub.name;
}

function loadConfig() {
  // У GitHub Actions конфіг приходить зі змінних середовища (secrets)
  if (process.env.WORKER_URL && process.env.API_KEY) {
    return { workerUrl: process.env.WORKER_URL.replace(/\/$/, ""), apiKey: process.env.API_KEY };
  }
  const path = join(homedir(), ".dou-jobs-bot.env");
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  if (!env.WORKER_URL || !env.API_KEY) throw new Error(`${path}: потрібні WORKER_URL і API_KEY`);
  return { workerUrl: env.WORKER_URL.replace(/\/$/, ""), apiKey: env.API_KEY };
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DESCRIPTION_CHARS);
}

async function api(cfg, method, path, body) {
  const res = await fetch(cfg.workerUrl + path, {
    method,
    headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cfg = loadConfig();
  const { subs } = await api(cfg, "GET", "/api/subs");
  log(`підписок до опитування: ${subs.length}`);

  let failed = 0;
  for (const [i, sub] of subs.entries()) {
    if (i > 0) await sleep(PAUSE_BETWEEN_FEEDS_MS);
    // Помилка однієї підписки не повинна зупиняти решту
    try {
      await pollOne(cfg, sub);
    } catch (err) {
      failed++;
      log(`✗ ${label(sub)}: ${err.message}`);
    }
  }
  if (failed > 0) process.exitCode = 1;
}

async function pollOne(cfg, sub) {
  const result = await fetchFeed(sub.url);

  if (!result.ok) {
    log(`✗ ${label(sub)}: ${result.error}`);
    // Усі помилки передаємо Worker'у: він рахує збої поспіль і сповіщає;
    // остаточні (fatal) ще й видаляють непідтверджену підписку
    const fatal = result.kind === "invalid" || result.status === 404 || result.status === 410;
    await api(cfg, "POST", "/api/ingest", { subId: sub.id, error: result.error, fatal });
    return;
  }

  const items = result.feed.items.slice(0, MAX_ITEMS).map((it) => ({
    key: it.key.slice(0, MAX_FIELD),
    title: it.title.slice(0, MAX_FIELD),
    link: it.link.slice(0, MAX_FIELD),
    description: stripHtml(it.description),
    pubDate: it.pubDate,
  }));
  const res = await api(cfg, "POST", "/api/ingest", {
    subId: sub.id,
    feedTitle: result.feed.title.slice(0, MAX_FIELD),
    items,
  });
  log(`✓ ${label(sub)}: у стрічці ${items.length}, надіслано ${res.sent ?? 0}${res.seeded ? " (перше опитування)" : ""}`);
}

main().catch((err) => {
  log("помилка:", err.message);
  process.exit(1);
});
