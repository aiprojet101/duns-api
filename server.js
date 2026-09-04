const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");
const { Resend } = require("resend");
const { spawn } = require("child_process");

// ── Xvfb launcher ─────────────────────────────────────────────────────────────
const _xvfbReady = new Promise((resolve) => {
  const xvfb = spawn("Xvfb", [":99", "-screen", "0", "1280x720x24", "-ac", "-nolisten", "tcp"]);
  xvfb.on("error", (err) => {
    console.error("[xvfb] spawn failed:", err.message, "— will try headless fallback");
    resolve();
  });
  xvfb.stderr.on("data", () => {}); // suppress noise
  setTimeout(() => {
    process.env.DISPLAY = ":99";
    console.log("[xvfb] display :99 ready");
    resolve();
  }, 4000);
});

const app = express();
const PORT = process.env.PORT || 3001;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || "DUNS Lookup <noreply@yourdomain.com>";
const FRONTEND_URL = process.env.FRONTEND_URL || "*";
const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_KEY;

// ── ScrapingBee (methode principale) ───────────────────────────────────────────
// dnb.com/upik est protege par un challenge Cloudflare que ni Playwright ni un
// fetch classique ne passent. ScrapingBee (stealth_proxy) le franchit de facon
// fiable : teste et valide le 2026-09-04 sur un vrai formulaire UPIK.
const COUNTRY_DE_TO_ISO = {
  "Frankreich": "FR", "Deutschland": "DE", "Belgien": "BE", "Schweiz": "CH",
  "Spanien": "ES", "Italien": "IT", "Grossbritannien": "GB",
  "Vereinigte Staaten von Amerika": "US", "Kanada": "CA", "Niederlande": "NL",
  "Luxemburg": "LU", "Portugal": "PT", "Osterreich": "AT", "Polen": "PL",
  "Schweden": "SE", "Danemark": "DK", "Finnland": "FI", "Norwegen": "NO",
  "Irland": "IE", "Marokko": "MA", "Tunesien": "TN", "Algerien": "DZ", "Senegal": "SN",
};

async function lookupViaScrapingBee(companyName, city, countryDe) {
  if (!SCRAPINGBEE_KEY) return null;
  const countryCode = COUNTRY_DE_TO_ISO[countryDe] || "FR";
  const cNameEsc = companyName.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

  const jsScenario = {
    instructions: [
      { wait: 3000 },
      { evaluate: `(function(){
          var inp = document.querySelector('input[placeholder="Suche hier..."]');
          if (!inp) return;
          var setVal = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setVal.call(inp, '${cNameEsc}');
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          var sel = document.querySelector('#country');
          if (sel) {
            var setSel = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
            setSel.call(sel, '${countryCode}');
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
        })()` },
      { wait: 500 },
      { evaluate: `document.querySelector('button[type="submit"]').click()` },
      { wait: 5000 },
    ],
  };

  const url = new URL("https://app.scrapingbee.com/api/v1/");
  url.searchParams.set("api_key", SCRAPINGBEE_KEY);
  url.searchParams.set("url", "https://www.dnb.com/de-de/upik.html");
  url.searchParams.set("stealth_proxy", "true");
  url.searchParams.set("js_scenario", JSON.stringify(jsScenario));

  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(90000) });
    if (!res.ok) {
      console.error("[scrapingbee] HTTP", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const html = await res.text();

    // Reduit le HTML a un texte ligne-par-ligne, dans le meme ordre que le DOM
    // (equivalent grossier de innerText, suffisant pour cette structure connue).
    const text = html.replace(/<[^>]+>/g, "\n").replace(/\n+/g, "\n");
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

    const results = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/D-U-N-S[^:]*:\s*([\d][\d\s-]{6,10}[\d])/i);
      if (!m) continue;
      const duns = m[1].replace(/[\s-]/g, "");
      if (duns.length !== 9) continue;
      const name = lines[i - 1] || companyName;
      let address = "";
      if (/Unternehmensadresse/i.test(lines[i + 1] || "")) {
        address = lines[i + 2] || "";
      }
      results.push({ name, duns, address });
    }
    console.log(`[scrapingbee] ${results.length} resultat(s) pour "${companyName}"`);
    return results;
  } catch (e) {
    console.error("[scrapingbee] erreur:", e.message);
    return null;
  }
}

// ── Free lookup methods (tried before the Playwright/UPIK scrape) ─────────────
// dnb.com/upik est desormais protege par un challenge Cloudflare que Playwright
// ne passe plus de facon fiable. On tente d'abord ces sources gratuites qui ne
// necessitent pas de navigateur, avant de retomber sur UPIK en dernier recours.

// Le formulaire UPIK utilise des libelles pays en allemand (cf mapping cote Next.js)
const COUNTRY_DE_TO_EN = {
  "Frankreich": "France", "Deutschland": "Germany", "Belgien": "Belgium",
  "Schweiz": "Switzerland", "Spanien": "Spain", "Italien": "Italy",
  "Grossbritannien": "United Kingdom", "Vereinigte Staaten von Amerika": "United States",
  "Kanada": "Canada", "Niederlande": "Netherlands", "Luxemburg": "Luxembourg",
  "Portugal": "Portugal", "Osterreich": "Austria", "Polen": "Poland",
  "Schweden": "Sweden", "Danemark": "Denmark", "Finnland": "Finland",
  "Norwegen": "Norway", "Irland": "Ireland", "Marokko": "Morocco",
  "Tunesien": "Tunisia", "Algerien": "Algeria", "Senegal": "Senegal",
};
const COUNTRY_DE_TO_JURISDICTION = {
  "Frankreich": "fr", "Deutschland": "de", "Belgien": "be", "Schweiz": "ch",
};

// Extraction stricte : seulement si explicitement labellise DUNS (evite les faux positifs
// sur des sources non-officielles comme DuckDuckGo ou Opencorporates)
function extractDunsStrict(text, label = "") {
  const mFmt = text.match(/\b(\d{2})-(\d{3})-(\d{4})\b/);
  if (mFmt) {
    const d = mFmt[1] + mFmt[2] + mFmt[3];
    if (label) console.log(`[free:${label}] format xx-xxx-xxxx: ${d}`);
    return d;
  }
  const mJson = text.match(/"duns(?:Number|Code)?"\s*[:\s]+["\s]*(\d{9})(?!\d)/i);
  if (mJson) {
    if (label) console.log(`[free:${label}] cle JSON duns: ${mJson[1]}`);
    return mJson[1];
  }
  const mLabel = text.match(/[Dd][-.\s]?[Uu][-.\s]?[Nn][-.\s]?[Ss][^0-9]{0,50}(\d{9})(?!\d)/);
  if (mLabel) {
    if (label) console.log(`[free:${label}] label DUNS avant: ${mLabel[1]}`);
    return mLabel[1];
  }
  const mAfter = text.match(/(?<!\d)(\d{9})(?!\d)[^a-zA-Z0-9]{0,20}[Dd][-.\s]?[Uu][-.\s]?[Nn][-.\s]?[Ss]/);
  if (mAfter) {
    if (label) console.log(`[free:${label}] label DUNS apres: ${mAfter[1]}`);
    return mAfter[1];
  }
  return null;
}

async function lookupFree(companyName, countryDe) {
  const countryEn = COUNTRY_DE_TO_EN[countryDe] || countryDe;

  // Methode 1 : API D&B directe (endpoint JSON public de dnb.com, distinct du site UPIK)
  try {
    const apiUrl = `https://www.dnb.com/api/v1/search?searchTerm=${encodeURIComponent(companyName)}&country=${encodeURIComponent(countryEn)}&pageNumber=1&pageSize=5`;
    const res = await fetch(apiUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
        "Referer": "https://www.dnb.com/",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const data = await res.json();
      const duns = extractDunsStrict(JSON.stringify(data), "API-DNB");
      if (duns) return { duns, name: companyName };
    }
  } catch (e) { console.error("[free] API D&B:", e.message); }

  // Methode 2 : DuckDuckGo (HTML, sans JS)
  try {
    const query = `"${companyName}" ${countryEn} DUNS number`;
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const html = await res.text();
      const duns = extractDunsStrict(html, "DuckDuckGo");
      if (duns) return { duns, name: companyName };
    }
  } catch (e) { console.error("[free] DuckDuckGo:", e.message); }

  // Methode 3 : Opencorporates (registres officiels, ne couvre que quelques juridictions)
  try {
    const jurisd = COUNTRY_DE_TO_JURISDICTION[countryDe] || "";
    const url = `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(companyName)}${jurisd ? "&jurisdiction_code=" + jurisd : ""}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const data = await res.json();
      const duns = extractDunsStrict(JSON.stringify(data), "Opencorporates");
      if (duns) return { duns, name: companyName };
    }
  } catch (e) { console.error("[free] Opencorporates:", e.message); }

  return null;
}

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(
  cors({
    origin: FRONTEND_URL === "*" ? true : FRONTEND_URL,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

// ── Browser singleton ─────────────────────────────────────────────────────────
let _browser = null;

function getBrowserArgs() {
  const display = process.env.DISPLAY || ":99";
  return {
    headless: false,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1280,720",
    ],
    env: { ...process.env, DISPLAY: display },
  };
}

async function getBrowser() {
  await _xvfbReady;
  if (_browser && _browser.isConnected()) return _browser;
  console.log("[browser] launching Chromium...");
  _browser = await chromium.launch(getBrowserArgs());
  _browser.on("disconnected", () => {
    console.warn("[browser] disconnected — will relaunch on next request");
    _browser = null;
  });
  console.log("[browser] Chromium ready");
  return _browser;
}

// ── Health check ──────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", browserReady: !!(_browser && _browser.isConnected()), ts: new Date().toISOString() });
});

// ── DUNS Lookup ───────────────────────────────────────────────────────────────

app.post("/api/lookup-duns", async (req, res) => {
  const { companyName, city = "", country = "Frankreich", email } = req.body;

  if (!companyName || !companyName.trim()) {
    return res.status(400).json({ error: "companyName is required" });
  }

  console.log(`[lookup] company="${companyName}" city="${city}" country="${country}" email="${email || "(none)"}"`);

  // Methode principale : ScrapingBee (contourne le Cloudflare d'UPIK). Si ScrapingBee
  // a reussi a interroger UPIK (meme avec 0 resultat), on fait confiance a cette
  // reponse plutot que de retomber sur Playwright, qui de toute facon se heurte au
  // meme Cloudflare et ne ferait que transformer un "non trouve" legitime en erreur.
  let results = [];
  let sbRan = false;
  try {
    const sbResults = await lookupViaScrapingBee(companyName, city, country);
    if (sbResults !== null) {
      sbRan = true;
      results = sbResults;
    }
  } catch (e) { console.error("[lookup] ScrapingBee erreur:", e.message); }

  // Sinon (ScrapingBee non configure ou en echec), sources gratuites avant de
  // retomber sur le scraping Playwright en tout dernier recours.
  if (!sbRan && results.length === 0) {
    try {
      const free = await lookupFree(companyName, country);
      if (free) {
        console.log(`[lookup] trouve via methode gratuite: ${free.duns}`);
        results = [{ name: free.name, duns: free.duns, address: "" }];
      }
    } catch (e) { console.error("[lookup] lookupFree erreur:", e.message); }
  }

  let context = null;

  try {
    if (!sbRan && results.length === 0) {
    const browser = await getBrowser();

    context = await browser.newContext({
      viewport: { width: 800, height: 600 },
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "de-DE",
      timezoneId: "Europe/Berlin",
    });

    // Pre-set TrustArc / GDPR consent cookies
    await context.addCookies([
      { name: "notice_behavior",                    value: "expressed,eu", domain: ".dnb.com", path: "/" },
      { name: "notice_gdpr_prefs",                  value: "0:1:2",        domain: ".dnb.com", path: "/" },
      { name: "cmapi_cookie_privacy",               value: "permit 1,2,3", domain: ".dnb.com", path: "/" },
      { name: "truste.eu.cookie.notice_gdpr_pr498", value: "1",            domain: ".dnb.com", path: "/" },
    ]);

    const page = await context.newPage();

    // Block unnecessary resources
    await page.route(/\.(png|jpg|jpeg|gif|svg|webp|ico|css|woff|woff2|ttf|eot|otf|mp4|mp3|pdf)(\?.*)?$/i, (route) => route.abort());
    await page.route(/\.js(\?.*)?$/i, (route) => {
      const url = route.request().url();
      return url.includes("dnb.com") ? route.continue() : route.abort();
    });
    await page.route(/google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar/i, (route) => route.abort());

    // Navigate
    console.log("[lookup] navigating to UPIK...");
    await page.goto("https://www.dnb.com/de-de/upik.html", { waitUntil: "domcontentloaded", timeout: 90_000 });

    // Wait for Cloudflare / page to settle
    console.log("[lookup] waiting for page to load...");
    await page.waitForFunction(
      () => {
        const title = document.title || "";
        const hasForm = !!document.querySelector('input[placeholder="Suche hier..."]') || !!document.querySelector("#country");
        return title.includes("UPIK") || hasForm;
      },
      { timeout: 20_000 }
    );
    console.log(`[lookup] page ready — title: "${await page.title()}"`);

    // Dismiss cookie banner via DOM removal (faster than click retries)
    await page.evaluate(() => {
      [
        "#truste-consent-track", "#truste-consent-content", ".truste-banner-overlay",
        "#trustarc-banner-overlay", "#consent_blackbar", "#truste-show-consent",
        ".truste_popframe", "iframe[id*='trustarc']", "iframe[src*='consent.trustarc']",
        "iframe[src*='truste']",
      ].forEach((s) => document.querySelectorAll(s).forEach((el) => el.remove()));
      [
        "notice_behavior=expressed,eu", "notice_gdpr_prefs=0:1:2",
        "cmapi_cookie_privacy=permit 1,2,3", "truste.eu.cookie.notice_gdpr_pr498=1",
      ].forEach((c) => { document.cookie = `${c};path=/;domain=.dnb.com`; });
      document.body.style.overflow = "auto";
      document.documentElement.style.overflow = "auto";
    });
    await page.waitForTimeout(100);

    // Select country
    const countrySelect = page.locator("#country");
    await countrySelect.waitFor({ state: "visible", timeout: 15_000 });
    await countrySelect.selectOption({ label: country });

    // Type company name
    const searchInput = page.locator('input[placeholder="Suche hier..."]');
    await searchInput.waitFor({ state: "visible", timeout: 10_000 });
    await searchInput.fill(companyName.trim());

    // Type city if provided
    if (city && city.trim()) {
      const cityInput = page.locator(
        'input[placeholder="Stadt"], input[name*="tadt"], input[name*="city"], input[id*="tadt"], input[id*="city"]'
      ).first();
      const cityVisible = await cityInput.isVisible({ timeout: 3_000 }).catch(() => false);
      if (cityVisible) {
        await cityInput.fill(city.trim());
      }
    }

    // Click submit
    const submitBtn = page.locator('button[type="submit"]').filter({
      hasNot: page.locator(':text("Suche löschen")'),
    });
    await submitBtn.first().click();

    // Wait for results intelligently
    await page.waitForFunction(
      () => {
        const text = document.body.innerText;
        return text.includes("Suchergebnisse") || text.includes("Keine Ergebnisse") || /D-U-N-S[^:]*:\s*\d/i.test(text);
      },
      { timeout: 30_000 }
    ).catch(() => console.log("[lookup] result wait timed out — extracting anyway"));

    // Extract results
    results = await page.evaluate(() => {
      const NAV_NOISE = /UPIK|Plattform|D&B|Was ist|Suche\s*(l.schen|hier)|Datenschutz|Impressum|Cookie|Hinweis|Suchergebnis/i;

      let searchRoot = document.body;
      {
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
          if (/^Suchergebnisse/i.test(n.textContent.trim())) {
            let el = n.parentElement;
            for (let i = 0; i < 4 && el && el.parentElement; i++) el = el.parentElement;
            searchRoot = el || document.body;
            break;
          }
        }
      }

      const extracted = [];
      const walker = document.createTreeWalker(searchRoot, NodeFilter.SHOW_TEXT);
      const visited = new Set();
      let node;

      while ((node = walker.nextNode())) {
        if (!/D-U-N-S[^:]*:\s*[\d]/i.test(node.textContent)) continue;
        let container = node.parentElement;
        for (let i = 0; i < 8; i++) {
          if (!container) break;
          const t = container.innerText || "";
          if (/D-U-N-S[^:]*:\s*[\d]/i.test(t) && (container.querySelector("a") || /Unternehmensadresse/i.test(t))) break;
          container = container.parentElement;
        }
        if (!container || visited.has(container)) continue;
        visited.add(container);
        const text = container.innerText || "";
        const dunsMatch = text.match(/D-U-N-S[^:]*:\s*([\d][\d\s\-]{6,10}[\d])/i);
        if (!dunsMatch) continue;
        const duns = dunsMatch[1].replace(/[\s\-]/g, "");
        if (duns.length !== 9) continue;
        const link = container.querySelector("a");
        let name = link ? link.innerText.trim() : "";
        if (!name) {
          const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
          const idx = lines.findIndex((l) => /D-U-N-S[^:]*:\s*[\d]/i.test(l));
          name = idx > 0 ? lines[idx - 1] : lines[0] || "";
        }
        const addrMatch = text.match(/Unternehmensadresse[:\s]+([^\n]+)/i);
        let address = addrMatch ? addrMatch[1].trim() : "";
        if (!address) {
          const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
          const idx = lines.findIndex((l) => /D-U-N-S[^:]*:\s*[\d]/i.test(l));
          if (idx >= 0 && idx + 1 < lines.length) {
            const candidate = lines[idx + 1];
            address = /Unternehmensadresse/i.test(candidate) ? (lines[idx + 2] || "") : candidate;
          }
        }
        extracted.push({ name, duns, address });
      }

      if (extracted.length === 0) {
        const allLines = (document.body.innerText || "").split("\n").map((l) => l.trim()).filter(Boolean);
        const startIdx = allLines.findIndex((l) => /^Suchergebnisse/i.test(l));
        const lines = startIdx >= 0 ? allLines.slice(startIdx) : allLines;
        for (let i = 0; i < lines.length; i++) {
          const dunsMatch = lines[i].match(/D-U-N-S[^:]*:\s*([\d][\d\s\-]{6,10}[\d])/i);
          if (!dunsMatch) continue;
          const duns = dunsMatch[1].replace(/[\s\-]/g, "");
          if (duns.length !== 9) continue;
          const name = i > 0 ? lines[i - 1] : "";
          let address = "";
          for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
            if (/Unternehmensadresse/i.test(lines[j])) {
              const inline = lines[j].replace(/Unternehmensadresse[:\s]*/i, "").trim();
              address = inline || (lines[j + 1] || "");
              break;
            }
          }
          extracted.push({ name, duns, address });
        }
      }

      return extracted.filter((r) => !NAV_NOISE.test(r.name) && r.name.length < 100);
    });

    console.log(`[lookup] found ${results.length} result(s)`);
    await page.close().catch(() => {});
    } // fin du bloc Playwright (skippe si trouve via methode gratuite)

    // Send email via Resend (optional)
    if (results.length > 0 && email && email.trim() && RESEND_API_KEY) {
      try {
        const resend = new Resend(RESEND_API_KEY);
        const resultRows = results.map((r, i) => `<tr>
          <td style="padding:8px;border:1px solid #ddd">${i + 1}</td>
          <td style="padding:8px;border:1px solid #ddd">${escapeHtml(r.name)}</td>
          <td style="padding:8px;border:1px solid #ddd"><b>${escapeHtml(r.duns)}</b></td>
          <td style="padding:8px;border:1px solid #ddd">${escapeHtml(r.address)}</td>
        </tr>`).join("");
        await resend.emails.send({
          from: EMAIL_FROM,
          to: email.trim(),
          subject: `DUNS Lookup : resultats pour "${companyName}"`,
          html: `<h2>Resultats DUNS pour : ${escapeHtml(companyName)}</h2>
            <table style="border-collapse:collapse;width:100%">
              <thead><tr style="background:#f5f5f5">
                <th style="padding:8px;border:1px solid #ddd">#</th>
                <th style="padding:8px;border:1px solid #ddd">Entreprise</th>
                <th style="padding:8px;border:1px solid #ddd">D-U-N-S</th>
                <th style="padding:8px;border:1px solid #ddd">Adresse</th>
              </tr></thead>
              <tbody>${resultRows}</tbody>
            </table>`,
        });
        console.log(`[lookup] email sent to ${email}`);

        // Schedule post-purchase follow-up sequence
        if (process.env.DISABLE_FOLLOWUP_EMAILS !== 'true') {
          const best = results.find((r) => r.name && r.duns) || results[0];
          const foundDuns = best?.duns || "";
          const foundName = best?.name || companyName;
          const unsubscribe = `<p style="font-size:11px;color:#888;margin-top:24px;border-top:1px solid #eee;padding-top:12px">Pour ne plus recevoir ces emails, repondez avec STOP.</p>`;

          // Email 2 — D+7 cross-sell papiers-entreprise.fr
          try {
            const scheduledAt2 = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
            await resend.emails.send({
              from: EMAIL_FROM,
              to: email.trim(),
              scheduledAt: scheduledAt2,
              subject: "Vos autres documents administratifs en quelques minutes",
              html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333;line-height:1.5">
                <h2 style="color:#0a3d62">Besoin d'autres documents pour ${escapeHtml(foundName)} ?</h2>
                <p>Bonjour,</p>
                <p>Vous avez recemment recupere votre numero <b>D-U-N-S</b> via DunsFrance.fr. Au-dela du DUNS, votre entreprise a souvent besoin d'autres justificatifs administratifs : <b>Kbis, TVA intracommunautaire, SIRET, EORI, bilans</b>.</p>
                <p>Notre service partenaire <b>Papiers Entreprise</b> reunit tous ces documents en un seul endroit, recuperables en quelques minutes.</p>
                <p style="text-align:center;margin:28px 0">
                  <a href="https://papiers-entreprise.fr" style="background:#0a3d62;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block;font-weight:bold">Decouvrir le Pack Complet - 5,90 EUR</a>
                </p>
                <p style="font-size:12px;color:#666"><i>DunsFrance.fr et Papiers Entreprise sont deux services independants complementaires.</i></p>
                ${unsubscribe}
              </div>`,
            });
            console.log(`[email] follow-up #2 scheduled for ${email}`);
          } catch (followErr2) {
            console.error("[email] follow-up #2 schedule failed:", followErr2.message);
          }

          // Email 3 — D+335 annual reminder
          try {
            const scheduledAt3 = new Date(Date.now() + 335 * 24 * 60 * 60 * 1000).toISOString();
            await resend.emails.send({
              from: EMAIL_FROM,
              to: email.trim(),
              scheduledAt: scheduledAt3,
              subject: "Verifiez que le numero DUNS de votre entreprise est toujours a jour",
              html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333;line-height:1.5">
                <h2 style="color:#0a3d62">Votre DUNS est-il toujours a jour ?</h2>
                <p>Bonjour,</p>
                <p>Il y a presque un an, vous avez recupere via DunsFrance.fr le numero D-U-N-S suivant :</p>
                <p style="background:#f5f5f5;padding:12px;border-left:4px solid #0a3d62;font-size:16px">
                  <b>${escapeHtml(foundName)}</b><br>
                  D-U-N-S : <b>${escapeHtml(foundDuns)}</b>
                </p>
                <p>Dun &amp; Bradstreet met regulierement a jour les fiches entreprise. <b>Adresse, capital, dirigeants, effectifs</b> peuvent avoir change. Beaucoup de plateformes (Apple, Google, appels d'offres, donneurs d'ordres) exigent un DUNS a jour.</p>
                <p style="text-align:center;margin:28px 0">
                  <a href="https://dunsfrance.fr" style="background:#0a3d62;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block;font-weight:bold">Verifier votre DUNS - 3,90 EUR</a>
                </p>
                ${unsubscribe}
              </div>`,
            });
            console.log(`[email] follow-up #3 scheduled for ${email}`);
          } catch (followErr3) {
            console.error("[email] follow-up #3 schedule failed:", followErr3.message);
          }
        }
      } catch (mailErr) {
        console.error("[lookup] email send failed:", mailErr.message);
      }
    }

    const best =
      results.find((r) => r.name && r.duns && r.address) ||
      results.find((r) => r.duns) ||
      null;
    const data = best
      ? { companyName: best.name || companyName, dunsNumber: best.duns, address: best.address || "" }
      : null;

    return res.json({ success: true, data });
  } catch (err) {
    console.error("[lookup] error:", err.message);
    return res.status(500).json({ error: "Lookup failed", details: err.message });
  } finally {
    if (context) await context.close().catch(() => {});
    if (_browser) { await _browser.close().catch(() => {}); _browser = null; }
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`[server] DUNS API listening on port ${PORT}`);
  console.log(`[server] DISPLAY=${process.env.DISPLAY || "(not set)"}`);
  console.log(`[server] RESEND=${RESEND_API_KEY ? "configured" : "NOT SET"}`);
  console.log(`[server] CORS origin=${FRONTEND_URL}`);
  console.log("[server] ready — browser will launch on first request");
});
