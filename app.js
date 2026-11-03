"use strict";

let viewer = null;
let model = null;
let spinning = false;
let currentPdbData = "";
let currentGeneName = "";
let currentProteinLength = 0;
let highlightedDomain = null;

const helixData = { gene: "", length: 0, domains: [], variants: [], cds: "", transcript: "", cdsMatches: null, cdsState: "" };
let requestHelixDraw = () => {};
let focusHelix = () => {};

const RECENT_KEY = "gene-explorer-recent";
const MAX_RECENT = 3;
const MAX_VARIANT_CARDS = 60;
const VARIANTS_COLLAPSED = 6;

const CACHE_KEY = "gene-explorer-cache-v1";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;
let activeController = null;
let requestSequence = 0;

function getCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}"); }
  catch { return {}; }
}
function setCache(cache) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); }
  catch (e) { console.warn("Cache write failed:", e); }
}
function cacheGet(key) {
  const item = getCache()[key];
  if (!item || Date.now() - item.timestamp > CACHE_TTL_MS) return null;
  return item.value;
}
function cacheSet(key, value) {
  const cache = getCache();
  cache[key] = { timestamp: Date.now(), value };
  setCache(cache);
}
function cacheKey(type, key) {
  return `${type}:${String(key).toUpperCase()}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryDelay(attempt, retryAfter) {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 10000);
  }
  return Math.min(1000 * 2 ** attempt, 8000) + Math.floor(Math.random() * 250);
}

async function apiFetch(url, options = {}, { retries = MAX_RETRIES, timeout = REQUEST_TIMEOUT_MS, signal } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (response.ok) return response;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === retries) {
        throw new Error(`Request failed (${response.status})`);
      }
      await sleep(retryDelay(attempt, response.headers.get("Retry-After")));
    } catch (error) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error.name === "AbortError") {
        if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
        lastError = new Error("Request timed out.");
      } else {
        lastError = error;
      }
      if (attempt === retries) throw lastError;
      await sleep(retryDelay(attempt));
    }
  }
  throw lastError || new Error("Request failed.");
}

function setStatus(msg, isErr = false, loading = false) {
  const s = document.getElementById("status");
  s.textContent = msg || "";
  s.className = "status" + (isErr ? " err" : "") + (loading ? " loading" : "");
}

function setLoading(loading) {
  ["geneInput","searchButton","styleSelect","colorSelect","spinToggle","resetButton",
   "zoomOutButton","zoomInButton","downloadPdbButton","downloadPngButton"]
    .forEach(id => { const el = document.getElementById(id); if (el) el.disabled = loading; });
  document.getElementById("searchButton").textContent = loading ? "Loading…" : "Search";
  const rail = document.getElementById("progressRail");
  rail.hidden = !loading;
  if (loading) setProgress(0);
}

function setProgress(activeIndex) {
  const segs = document.querySelectorAll("#progressRail .progress-seg");
  segs.forEach((seg, i) => {
    seg.classList.toggle("done", i < activeIndex);
    seg.classList.toggle("active", i === activeIndex);
  });
}

function resetResultPanels() {
  document.getElementById("info").innerHTML = "";
  document.getElementById("learnGrid").innerHTML = "";
  document.getElementById("learnEmpty").style.display = "block";
  document.getElementById("residueBar").textContent = "Click any residue in the structure to inspect it.";
  document.getElementById("locationSection").style.display = "none";
  document.getElementById("interproSection").hidden = true;
  document.getElementById("interproMeta").textContent = "";
  document.getElementById("domainMap").innerHTML = "";
  document.getElementById("domainScale").innerHTML = "";
  document.getElementById("interproList").innerHTML = "";
  document.getElementById("interproHint").textContent = "";
  document.getElementById("ideoContainer").innerHTML = "";
  document.getElementById("ideoHint").textContent = "";
  document.getElementById("ideoLocText").textContent = "";
  resetExtraSections();
  Object.assign(helixData, { gene: "", length: 0, domains: [], variants: [], cds: "", transcript: "", cdsMatches: null, cdsState: "" });
  requestHelixDraw();
  highlightedDomain = null;
  currentProteinLength = 0;
  currentPdbData = "";
  model = null;
  if (viewer) {
    try { viewer.clear(); viewer.render(); } catch (e) { console.warn("Viewer reset failed:", e); }
  }
}

function isCurrentRequest(id) {
  return id === requestSequence;
}

window.addEventListener("load", () => {
  try {
    const empty = document.getElementById("emptyState");
    if (empty) empty.remove();
    viewer = $3Dmol.createViewer("viewer", { backgroundColor: 0x000000 });
    viewer.render();
    attachGentleZoom(document.getElementById("viewer"), () => viewer);
  } catch (e) {
    setStatus("Viewer failed to initialize: " + e.message, true);
    console.error(e);
  }

  document.getElementById("searchButton").addEventListener("click", loadGene);
  document.getElementById("geneInput").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.repeat) loadGene();
  });
  document.getElementById("styleSelect").addEventListener("change", () => { applyColoring(); reapplyDomainHighlight(); });
  document.getElementById("colorSelect").addEventListener("change", () => { applyColoring(); reapplyDomainHighlight(); });
  document.getElementById("spinToggle").addEventListener("change", toggleSpin);
  document.getElementById("resetButton").addEventListener("click", resetView);
  document.getElementById("zoomInButton").addEventListener("click", zoomIn);
  document.getElementById("zoomOutButton").addEventListener("click", zoomOut);
  document.getElementById("downloadPdbButton").addEventListener("click", downloadPDB);
  document.getElementById("downloadPngButton").addEventListener("click", downloadPNG);

  document.getElementById("info").addEventListener("click", e => {
    const toggle = e.target.closest(".collapsible-toggle");
    if (toggle) toggleCollapsible(toggle.dataset.target);
  });

  // Recent-search chips load a gene on click (partner chips open a new tab instead)
  document.getElementById("recentRow")?.addEventListener("click", e => {
    const chip = e.target.closest(".gene-chip");
    if (chip?.dataset.gene) searchGene(chip.dataset.gene);
  });
  document.getElementById("variantMore")?.addEventListener("click", toggleVariantCards);
  renderRecent();

  // Shareable links: ?gene=FMR1 loads that gene straight away
  const geneParam = new URLSearchParams(window.location.search).get("gene");
  if (geneParam) {
    document.getElementById("geneInput").value = geneParam;
    loadGene();
  }
});

function attachGentleZoom(el, getViewer) {
  el.addEventListener("wheel", (e) => {
    const v = getViewer();
    if (!v) return;
    e.preventDefault();
    e.stopPropagation();
    const factor = e.deltaY > 0 ? 0.97 : 1.03;
    v.zoom(factor, 0);
    v.render();
  }, { passive: false, capture: true });
}

async function fetchUniprotAccession(gene, organismClause, signal) {
  const key = cacheKey("uniprot-search", gene);
  const cached = cacheGet(key);
  if (cached) return cached;
  const url = `https://rest.uniprot.org/uniprotkb/search?query=gene:${gene}+AND+reviewed:true${organismClause}&fields=accession,protein_name,organism_name,length,mass,cc_function,cc_disease,gene_names,cc_subcellular_location&format=json&size=1`;
  const res = await apiFetch(url, {}, { signal });
  const data = await res.json();
  const result = data.results?.[0] || null;
  if (result) cacheSet(key, result);
  return result;
}

async function fetchAlphaFoldStructure(accession, signal) {
  const key = cacheKey("alphafold-pdb", accession);
  const cached = cacheGet(key);
  if (cached) return cached;
  const metaRes = await apiFetch(`https://alphafold.ebi.ac.uk/api/prediction/${accession}`, {}, { signal });
  const metaData = await metaRes.json();
  if (!metaData?.length || !metaData[0]?.pdbUrl) return null;
  const pdbRes = await apiFetch(metaData[0].pdbUrl, {}, { signal });
  const pdb = await pdbRes.text();
  if (pdb) cacheSet(key, pdb);
  return pdb || null;
}

async function fetchInterProAnnotations(accession, signal) {
  const key = cacheKey("interpro", accession);
  const cached = cacheGet(key);
  if (cached) return cached;

  let url = `https://www.ebi.ac.uk/interpro/api/entry/interpro/protein/uniprot/${encodeURIComponent(accession)}/?page_size=200`;
  const results = [];
  let pages = 0;

  while (url && pages < 10) {
    const res = await apiFetch(url, { headers: { Accept: "application/json" } }, { signal });
    const data = await res.json();
    results.push(...(data.results || []));
    url = data.next || null;
    pages++;
  }

  const normalized = results.map(entry => {
    const metadata = entry.metadata || {};
    const protein = entry.proteins?.[0] || {};
    const locations = protein.entry_protein_locations || [];
    const fragments = locations.flatMap(location =>
      (location.fragments || []).map(fragment => ({
        start: Number(fragment.start),
        end: Number(fragment.end),
        representative: fragment.representative === true
      }))
    ).filter(f => Number.isFinite(f.start) && Number.isFinite(f.end) && f.start > 0 && f.end >= f.start);

    return {
      accession: metadata.accession || "",
      name: typeof metadata.name === "string" ? metadata.name : (metadata.name?.name || "Unnamed InterPro entry"),
      type: metadata.type || "feature",
      fragments
    };
  }).filter(entry => entry.accession);

  cacheSet(key, normalized);
  return normalized;
}

function interProTypeLabel(type) {
  return String(type || "feature").replace(/_/g, " ");
}

function interProTypeClass(type) {
  const t = String(type || "").toLowerCase();
  if (t.includes("domain")) return "domain";
  if (t.includes("family")) return "family";
  if (t.includes("superfamily")) return "superfamily";
  if (t.includes("repeat")) return "repeat";
  return "feature";
}

function renderInterPro(entries, proteinLength) {
  const section = document.getElementById("interproSection");
  const meta = document.getElementById("interproMeta");
  const map = document.getElementById("domainMap");
  const scale = document.getElementById("domainScale");
  const list = document.getElementById("interproList");
  const hint = document.getElementById("interproHint");

  section.hidden = false;
  map.innerHTML = "";
  scale.innerHTML = "";
  list.innerHTML = "";
  hint.textContent = "";

  if (!entries?.length) {
    meta.textContent = "No InterPro entries were found for this protein.";
    hint.textContent = "InterPro does not have a classified family, domain, or sequence feature for every protein.";
    return;
  }

  const length = Number(proteinLength) || Math.max(1, ...entries.flatMap(e => e.fragments.map(f => f.end)));
  const locatedEntries = entries.filter(e => e.fragments.length > 0);
  helixData.domains = locatedEntries
    .filter(e => ["domain", "repeat"].includes(interProTypeClass(e.type)))
    .flatMap(e => e.fragments.map(fragment => ({ entry: e, fragment })));
  requestHelixDraw();
  meta.textContent = `${entries.length} InterPro entr${entries.length === 1 ? "y" : "ies"} · ${locatedEntries.length} with sequence coordinates · protein length ${length} aa`;

  const track = document.createElement("div");
  track.className = "domain-track";
  map.appendChild(track);
  wireMapToHelix(map, track, length, ".domain-bar");

  const colors = {
    domain: "#e8a94a",
    family: "#8aa7d9",
    superfamily: "#9b8fd4",
    repeat: "#78bfa0",
    feature: "#85837a"
  };

  locatedEntries.forEach(entry => {
    const color = colors[interProTypeClass(entry.type)] || colors.feature;
    entry.fragments.forEach(fragment => {
      const left = Math.max(0, Math.min(100, ((fragment.start - 1) / length) * 100));
      const width = Math.max(0.7, Math.min(100 - left, ((fragment.end - fragment.start + 1) / length) * 100));
      const domainKey = `${entry.accession}:${fragment.start}-${fragment.end}`;
      const externalUrl = `https://www.ebi.ac.uk/interpro/entry/InterPro/${encodeURIComponent(entry.accession)}/`;

      const bar = document.createElement("a");
      bar.className = "domain-bar";
      bar.href = externalUrl;
      bar.target = "_blank";
      bar.rel = "noopener";
      bar.dataset.domainKey = domainKey;
      bar.style.left = `${left}%`;
      bar.style.width = `${width}%`;
      bar.style.background = color;
      bar.setAttribute("aria-label", `${entry.accession}: ${entry.name}, residues ${fragment.start} to ${fragment.end}. Click to highlight in the 3D structure.`);
      bar.title = `${entry.accession} · ${entry.name} · residues ${fragment.start}-${fragment.end}`;
      bar.addEventListener("click", (e) => {
        if (e.metaKey || e.ctrlKey) return; // let it open externally
        e.preventDefault();
        highlightDomain(entry, fragment, bar);
      });
      track.appendChild(bar);
    });
  });

  const scaleStart = document.createElement("span");
  scaleStart.textContent = "1 aa";
  const scaleEnd = document.createElement("span");
  scaleEnd.textContent = `${length} aa`;
  scale.append(scaleStart, scaleEnd);

  const sorted = [...entries].sort((a, b) => {
    const af = a.fragments[0]?.start ?? Infinity;
    const bf = b.fragments[0]?.start ?? Infinity;
    return af - bf || a.accession.localeCompare(b.accession);
  });

  sorted.forEach(entry => {
    const item = document.createElement("div");
    item.className = "interpro-item";
    const ranges = entry.fragments.length
      ? entry.fragments.map(f => `${f.start}-${f.end}`).join(", ") + " aa"
      : "No sequence coordinates";
    item.innerHTML = `
      <div class="interpro-item-head">
        <a href="https://www.ebi.ac.uk/interpro/entry/InterPro/${encodeURIComponent(entry.accession)}/" target="_blank" rel="noopener">${escapeHtml(entry.accession)}</a>
        <span class="interpro-type">${escapeHtml(interProTypeLabel(entry.type))}</span>
      </div>
      <div class="interpro-name">${escapeHtml(entry.name)}</div>
      <div class="interpro-range">${escapeHtml(ranges)}</div>
    `;
    const firstFragment = entry.fragments[0];
    if (firstFragment) {
      item.dataset.domainKey = `${entry.accession}:${firstFragment.start}-${firstFragment.end}`;
      item.classList.add("clickable");
      item.tabIndex = 0;
      item.setAttribute("role", "button");
      item.setAttribute("aria-label", `Highlight ${entry.name} on the 3D structure`);
      item.addEventListener("click", (e) => {
        if (e.target.closest("a")) return; // let the accession link navigate normally
        highlightDomain(entry, firstFragment, item);
      });
      item.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); highlightDomain(entry, firstFragment, item); }
      });
    }
    list.appendChild(item);
  });

  hint.textContent = "Click a domain bar or card to highlight it on the 3D structure above · ctrl/cmd-click a bar to open its InterPro entry instead.";
}

async function fetchNcbiGene(geneId, signal) {
  if (!geneId || geneId === "-") return null;
  const key = cacheKey("ncbi-gene", geneId);
  const cached = cacheGet(key);
  if (cached) return cached;
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=gene&id=${geneId}&retmode=json`;
  const res = await apiFetch(url, {}, { signal });
  const data = await res.json();
  const doc = data.result?.[geneId];
  if (!doc) return null;

  const summary = typeof doc.summary === "string" ? doc.summary.trim() : "";
  let loc = null;
  const gi = (doc.genomicinfo || [])[0];
  const chr = doc.chromosome || gi?.chrloc;
  if (chr && gi) {
    const a = parseInt(gi.chrstart, 10), b = parseInt(gi.chrstop, 10);
    if (!isNaN(a) && !isNaN(b)) {
      loc = { chr: String(chr), mapLocation: doc.maplocation || "", start: Math.min(a, b), stop: Math.max(a, b) };
    }
  }
  const result = { loc, summary };
  cacheSet(key, result);
  return result;
}


function renderIdeogram(loc, geneSymbol, geneId) {
  const section = document.getElementById("locationSection");
  const container = document.getElementById("ideoContainer");
  const hint = document.getElementById("ideoHint");
  container.innerHTML = "";
  hint.textContent = "";

  if (!loc) {
    section.hidden = true;
    section.style.display = "none";
    return;
  }
  if (typeof Ideogram === "undefined") {
    section.hidden = false;
    section.style.display = "block";
    hint.textContent = "Chromosome diagram library failed to load (check your network connection).";
    return;
  }

  section.hidden = false;
  section.style.display = "block";
  document.getElementById("ideoLocText").textContent =
    `Chromosome ${loc.chr}${loc.mapLocation ? " · band " + loc.mapLocation : ""} · ` +
    `chr${loc.chr}:${loc.start.toLocaleString()}-${loc.stop.toLocaleString()}`;

  const annotation = [{
    name: geneSymbol,
    chr: loc.chr,
    start: loc.start,
    stop: loc.stop,
    color: "#ff4d4d"
  }];

  // Ideogram.js doesn't have a documented click-on-annotation callback, so
  // after the ideogram loads we manually attach a click handler to the
  // rendered annotation element to link out to NCBI Gene.
  function wireClickThrough() {
    if (!geneId || geneId === "-") return;
    const annots = container.querySelectorAll('[class*="annot"]');
    annots.forEach((el) => {
      el.style.cursor = "pointer";
      el.addEventListener("click", () => {
        window.open(`https://www.ncbi.nlm.nih.gov/gene/${geneId}`, "_blank", "noopener");
      });
    });
  }

  // Ideogram lays the chromosomes out at a fixed min-width, which overflows the
  // card and adds scrollbars. Give the SVG a viewBox so it scales to fit instead.
  function fitIdeogram() {
    const svg = container.querySelector("svg");
    if (!svg) return;
    let box;
    try { box = svg.getBBox(); } catch { return; }
    if (!box || !box.width || !box.height) return;
    const pad = 8;
    const x = box.x - pad, y = box.y - pad, w = box.width + pad * 2, h = box.height + pad * 2;
    svg.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMin meet");
    svg.setAttribute("width", "100%");
    svg.removeAttribute("height");
    svg.style.minWidth = "0";
    svg.style.height = "auto";
    svg.style.aspectRatio = `${w} / ${h}`;
    const mid = document.getElementById("_ideogramMiddleWrap");
    if (mid) { mid.style.height = "auto"; mid.style.overflow = "hidden"; }
    const inner = document.getElementById("_ideogramInnerWrap");
    if (inner) {
      inner.style.position = "relative";
      inner.style.overflow = "visible";
      inner.style.maxWidth = "none";
      inner.style.width = "100%";
    }
  }

  try {
    new Ideogram({
      container: "#ideoContainer",
      organism: "human",
      chrHeight: 300,
      rotatable: false,
      annotationsLayout: "overlay",
      annotationHeight: 6,
      annotations: annotation,
      onLoad: () => { fitIdeogram(); wireClickThrough(); }
    });
  } catch (e) {
    console.error("Ideogram render failed", e);
    hint.textContent = "Couldn't render the chromosome diagram: " + e.message;
    return;
  }

  hint.textContent = geneId && geneId !== "-"
    ? `Red mark shows ${geneSymbol}'s position · click it to open the NCBI Gene page`
    : `Red mark shows ${geneSymbol}'s position on the chromosome`;
}


function renderInfo(fields) {
  const info = document.getElementById("info");
  info.innerHTML = fields.map((f, idx) => `
    <div class="field${f.wide ? ' wide' : ''}${f.collapsible ? ' collapsible' : ''}" ${f.collapsible ? `id="${f.id}"` : ''}>
      <div class="field-label">
        ${f.collapsible ? `<button type="button" class="collapsible-toggle" data-target="${f.id}" aria-expanded="false">${f.label}<span class="caret">&#9656;</span></button>` : f.label}
      </div>
      <div class="field-value${f.mono ? ' mono' : ''}${f.scroll ? ' scroll' : ''}">${f.value}</div>
      ${f.detail ? `<div class="ss-detail">${f.detail}</div>` : ''}
    </div>
  `).join("");
}

function toggleCollapsible(id) {
  const el = document.getElementById(id);
  const button = el?.querySelector(".collapsible-toggle");
  if (el) {
    const open = el.classList.toggle("open");
    button?.setAttribute("aria-expanded", String(open));
  }
}

function cleanText(t) {
  if (!t) return "";
  return t.replace(/\(PubMed:\d+(,\s*PubMed:\d+)*\)/gi, "")
           .replace(/\[PubMed:\d+\]/gi, "")
           .replace(/\s{2,}/g, " ")
           .trim();
}

function renderLearnLinks(gene, accession, geneId) {
  const links = [
    { name: "UniProt", url: `https://www.uniprot.org/uniprotkb/${accession}/entry`, desc: "Full curated protein record" },
    { name: "AlphaFold DB", url: `https://alphafold.ebi.ac.uk/entry/${accession}`, desc: "Source page for this structure" },
    { name: "InterPro", url: `https://www.ebi.ac.uk/interpro/search/text/${encodeURIComponent(accession)}/`, desc: "Protein families, domains and features" },
    { name: "GeneCards", url: `https://www.genecards.org/cgi-bin/carddisp.pl?gene=${encodeURIComponent(gene)}`, desc: "Aggregated gene summary" },
    { name: "RCSB PDB", url: `https://www.rcsb.org/search?q=${encodeURIComponent(gene)}`, desc: "Experimentally solved structures, if any" },
    { name: "PubMed", url: `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(gene + " Homo sapiens")}`, desc: "Full literature search" },
    { name: "Ensembl", url: `https://www.ensembl.org/Homo_sapiens/Gene/Summary?g=${encodeURIComponent(gene)}`, desc: "Genomic context, transcripts, variants" },
    { name: "STRING", url: `https://string-db.org/network/${encodeURIComponent(gene)}`, desc: "Protein-protein interaction network" }
  ];
  if (geneId && geneId !== "-") {
    links.splice(2, 0, { name: "NCBI Gene", url: `https://www.ncbi.nlm.nih.gov/gene/${geneId}`, desc: "Genomic location, aliases, expression" });
  }
  document.getElementById("learnEmpty").style.display = "none";
  document.getElementById("learnGrid").innerHTML = links.map(l => `
    <a class="learn-card" href="${l.url}" target="_blank" rel="noopener">
      <div class="learn-name">${l.name}</div>
      <div class="learn-desc">${l.desc}</div>
    </a>
  `).join("");
}

function computeSecondaryStructureStats() {
  if (!model) return null;
  const atoms = model.selectedAtoms({ atom: "CA" });
  if (atoms.length === 0) return null;
  let helix = 0, sheet = 0, coil = 0;
  atoms.forEach(a => {
    if (a.ss === "h") helix++;
    else if (a.ss === "s") sheet++;
    else coil++;
  });
  const total = atoms.length;
  return {
    helix: ((helix / total) * 100).toFixed(0),
    sheet: ((sheet / total) * 100).toFixed(0),
    coil: ((coil / total) * 100).toFixed(0),
    helixCount: helix,
    sheetCount: sheet,
    coilCount: coil,
    total
  };
}

function ssDetailHtml(ss) {
  if (!ss) return "";
  const row = (label, color, pct, count) => `
    <div>${label} &middot; ${pct}% (${count} residues)</div>
    <div class="ss-bar-row">
      <div class="ss-bar-track"><div class="ss-bar-fill" style="width:${pct}%;background:${color}"></div></div>
    </div>`;
  return `
    ${row("Helix", "#e8a94a", ss.helix, ss.helixCount)}
    ${row("Sheet", "#5eaefc", ss.sheet, ss.sheetCount)}
    ${row("Coil", "#85837a", ss.coil, ss.coilCount)}
    <div style="margin-top:0.5rem;">Total residues modeled: ${ss.total}</div>
  `;
}

async function loadGene() {
  if (!viewer) { setStatus("Viewer not ready yet, try again in a second.", true); return; }
  const input = document.getElementById("geneInput");
  const rawInput = input.value.trim();
  if (!rawInput) {
    setStatus("Enter a gene symbol first.", true);
    input.focus();
    return;
  }

  const gene = rawInput.toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z0-9.-]+$/.test(gene)) {
    setStatus("Enter a valid gene symbol.", true);
    return;
  }

  if (activeController) activeController.abort();
  activeController = new AbortController();
  const signal = activeController.signal;
  const requestId = ++requestSequence;
  currentGeneName = gene;
  setLoading(true);
  resetResultPanels();
  setStatus(`Searching ${gene}…`, false, true);
  setProgress(0);

  try {
    const protein = await fetchUniprotAccession(gene, "+AND+organism_id:9606", signal);
    if (!isCurrentRequest(requestId)) return;
    if (!protein) {
      setStatus(`No reviewed UniProt entry found for ${gene}.`, true);
      return;
    }

    const accession = protein.primaryAccession;
    const proteinName = protein.proteinDescription?.recommendedName?.fullName?.value || "Unknown";
    const length = protein.sequence?.length || 0;
    currentProteinLength = length;
    helixData.gene = gene;
    helixData.length = length;
    const mass = protein.sequence?.molWeight ? (protein.sequence.molWeight / 1000).toFixed(1) + " kDa" : "-";
    const functionText = cleanText(protein.comments?.find(c => c.commentType === "FUNCTION")?.texts?.[0]?.value) || "No function summary available.";
    const diseaseText = cleanText(protein.comments?.find(c => c.commentType === "DISEASE")?.disease?.description) || "No disease association listed.";
    const synonyms = (protein.genes?.[0]?.synonyms || []).map(s => s.value);
    const aliases = synonyms.length ? synonyms.join(", ") : "No known aliases listed.";
    const subcellLocs = (protein.comments?.find(c => c.commentType === "SUBCELLULAR_LOCATION")?.subcellularLocations || [])
      .map(l => l.location?.value).filter(Boolean);
    const subcellText = subcellLocs.length ? subcellLocs.join(", ") : "Not annotated.";

    setStatus(`Fetching structure for ${accession}…`, false, true);
    setProgress(1);
    const pdbData = await fetchAlphaFoldStructure(accession, signal);
    if (!isCurrentRequest(requestId)) return;
    if (!pdbData) {
      setStatus(`No AlphaFold structure available for ${accession}.`, true);
      return;
    }

    currentPdbData = pdbData;
    viewer.clear();
    model = viewer.addModel(pdbData, "pdb");
    applyColoring();
    viewer.zoomTo();
    viewer.render();

    viewer.setClickable({}, true, atom => {
      if (!atom) return;
      const confidence = atom.b != null ? Number(atom.b).toFixed(1) : "-";
      const codon = codonInfo(Number(atom.resi));
      document.getElementById("residueBar").innerHTML =
        `<strong>${escapeHtml(atom.resn)} ${escapeHtml(atom.resi)}</strong> · chain ${escapeHtml(atom.chain || "-")} · confidence (pLDDT): ${confidence}` +
        (codon ? ` · codon ${codon.codon} (c.${codon.cStart}–${codon.cEnd})` : "");
      focusHelix(Number(atom.resi), "structure");
    });

    const ss = computeSecondaryStructureStats();

    // Variants, partners and expression load in the background, each in its
    // own section, so a slow or failing API never blocks the main result.
    loadExtras(gene, accession, length, requestId, signal);

    // The core result is usable even if enrichment APIs fail.
    let refsHtml = "No linked publications found.";
    let geneId = "-";
    let ncbiSummary = "";
    let fullDataForCds = null;
    setStatus("Loading annotations and references…", false, true);
    setProgress(2);

    try {
      const fullKey = cacheKey("uniprot-full", accession);
      let fullData = cacheGet(fullKey);
      if (!fullData) {
        const fullRes = await apiFetch(`https://rest.uniprot.org/uniprotkb/${accession}.json`, {}, { signal });
        fullData = await fullRes.json();
        cacheSet(fullKey, fullData);
      }
      fullDataForCds = fullData;
      geneId = (fullData.uniProtKBCrossReferences || []).find(x => x.database === "GeneID")?.id || "-";
      const refs = (fullData.references || []).slice(0, 12).map(r => {
        const pmid = (r.citationCrossReferences || []).find(x => x.database === "PubMed")?.id;
        const title = escapeHtml(r.citation?.title || "Untitled");
        const journal = escapeHtml(r.citation?.journal || "");
        const year = escapeHtml(r.citation?.publicationDate || "");
        const titleHtml = pmid
          ? `<a class="ref-title-link" href="https://pubmed.ncbi.nlm.nih.gov/${pmid}/" target="_blank" rel="noopener">${title}</a>`
          : `<span class="ref-title-link" style="color:var(--text);">${title}</span>`;
        const linkLine = pmid ? `<a href="https://pubmed.ncbi.nlm.nih.gov/${pmid}/" target="_blank" rel="noopener">PMID:${pmid} →</a>` : "";
        return `<div class="ref-item">${titleHtml}<div class="ref-meta">${journal} ${year}</div>${linkLine}</div>`;
      });
      if (refs.length) refsHtml = refs.join("");
    } catch (e) {
      if (e.name === "AbortError") throw e;
      console.error("Reference enrichment failed:", e);
      refsHtml = `<div class="error-note">References temporarily unavailable. The structure and core annotation loaded successfully.</div>`;
    }

    if (!isCurrentRequest(requestId)) return;
    loadCds(gene, accession, fullDataForCds, requestId, signal); // background: real coding sequence for the helix
    setProgress(3);
    setStatus("Loading protein domains and features…", false, true);

    try {
      const interProEntries = await fetchInterProAnnotations(accession, signal);
      if (isCurrentRequest(requestId)) renderInterPro(interProEntries, length);
    } catch (e) {
      if (e.name === "AbortError") throw e;
      console.error("InterPro enrichment failed:", e);
      const section = document.getElementById("interproSection");
      section.hidden = false;
      document.getElementById("interproMeta").textContent = "InterPro annotations are temporarily unavailable.";
      document.getElementById("domainMap").innerHTML = "";
      document.getElementById("domainScale").innerHTML = "";
      document.getElementById("interproList").innerHTML = `<div class="error-note">Couldn't load InterPro annotations. The structure and other gene information are still available.</div>`;
      document.getElementById("interproHint").textContent = "Retry the search later to fetch InterPro domains and features.";
    }

    if (!isCurrentRequest(requestId)) return;
    setProgress(4);
    setStatus("Loading genomic location…", false, true);

    try {
      const ncbi = await fetchNcbiGene(geneId, signal);
      ncbiSummary = ncbi?.summary || "";
      if (isCurrentRequest(requestId)) renderIdeogram(ncbi?.loc || null, gene, geneId);
    } catch (e) {
      if (e.name === "AbortError") throw e;
      console.error("Genomic location fetch failed:", e);
      document.getElementById("locationSection").style.display = "block";
      document.getElementById("ideoContainer").innerHTML = "";
      document.getElementById("ideoHint").textContent = "Genomic location is temporarily unavailable. The rest of the gene result is still usable.";
    }

    if (!isCurrentRequest(requestId)) return;

    renderInfo([
      { label: "Gene", value: `${escapeHtml(gene)} · ${escapeHtml(accession)}`, mono: true },
      { label: "NCBI Gene ID", value: escapeHtml(geneId), mono: true },
      { label: "Protein", value: escapeHtml(proteinName) },
      { label: "Aliases", value: escapeHtml(aliases) },
      { label: "Subcellular location", value: escapeHtml(subcellText) },
      { label: "Length / mass", value: `${length} aa · ${escapeHtml(mass)}`, mono: true },
      { label: "Secondary structure", value: ss ? `${ss.helix}% helix · ${ss.sheet}% sheet · ${ss.coil}% coil · click to expand` : "-", mono: true, collapsible: true, id: "ssField", detail: ssDetailHtml(ss) },
      ...(ncbiSummary ? [{ label: "Gene summary (NCBI)", value: escapeHtml(ncbiSummary), scroll: true, wide: true }] : []),
      { label: "Function", value: escapeHtml(functionText), scroll: true, wide: true },
      { label: "Disease association", value: escapeHtml(diseaseText), wide: true },
      { label: "Referenced papers", value: refsHtml, scroll: true, wide: true }
    ]);
    renderLearnLinks(gene, accession, geneId);
    setProgress(5);
    setStatus("Loaded successfully.");
    addRecent(gene);
    try { history.replaceState(null, "", `?gene=${encodeURIComponent(gene)}`); } catch { /* ignore */ }
  } catch (err) {
    if (err.name === "AbortError") return;
    console.error(err);
    setStatus(err.message || "Something went wrong while loading this gene.", true);
  } finally {
    if (isCurrentRequest(requestId)) {
      setLoading(false);
      activeController = null;
    }
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;"
  }[ch]));
}

function applyColoring() {
  if (!viewer || !model) return;
  const colorMode = document.getElementById("colorSelect").value;
  const styleMode = document.getElementById("styleSelect").value;

  viewer.setStyle({}, {});

  let colorSpec;
  if (colorMode === "confidence") colorSpec = { colorfunc: (atom) => plddtColor(atom.b) };
  else if (colorMode === "chain") colorSpec = { color: "chain" };
  else if (colorMode === "secondary") colorSpec = { color: "ssPyMOL" };
  else colorSpec = { color: "spectrum" };

  if (styleMode === "sphere") {
    viewer.setStyle({ atom: "CA" }, { sphere: { ...colorSpec, radius: 1.1 } });
  } else {
    const styleObj = {};
    styleObj[styleMode] = colorSpec;
    viewer.setStyle({}, styleObj);
  }

  document.getElementById("legend-confidence").style.display = colorMode === "confidence" ? "flex" : "none";
  document.getElementById("legend-spectrum").style.display = colorMode === "spectrum" ? "flex" : "none";
  document.getElementById("legend-secondary").style.display = colorMode === "secondary" ? "flex" : "none";

  viewer.render();
}

function reapplyDomainHighlight() {
  if (!viewer || !model || !highlightedDomain) return;
  const sel = { resi: `${highlightedDomain.start}-${highlightedDomain.end}` };
  const outside = { not: sel };
  const styleMode = document.getElementById("styleSelect").value;
  const GREY = "#5c5c5c";

  // applyColoring() has already painted the whole protein in the current
  // color scheme. Grey out everything outside the domain so the domain keeps
  // its real colors and the rest of the structure fades to black & white.
  if (styleMode === "sphere") {
    viewer.setStyle({ atom: "CA", ...outside }, { sphere: { color: GREY, radius: 1.1 } });
  } else {
    viewer.setStyle(outside, { [styleMode]: { color: GREY } });
  }
  // Single residues (variants) are hard to see in cartoon, so show their side chains
  if (styleMode === "cartoon" && highlightedDomain.end - highlightedDomain.start <= 2) {
    viewer.addStyle(sel, { stick: { radius: 0.25 } });
  }
  viewer.render();
}

function highlightDomain(entry, fragment, sourceEl) {
  if (!viewer || !model) return;

  document.querySelectorAll(".domain-bar.active, .interpro-item.active, .variant-tick.active").forEach(el => el.classList.remove("active"));

  const isSame = highlightedDomain
    && highlightedDomain.accession === entry.accession
    && highlightedDomain.start === fragment.start
    && highlightedDomain.end === fragment.end;

  applyColoring(); // clears any previous highlight overlay, reapplies base style

  if (isSame) {
    highlightedDomain = null;
    requestHelixDraw();
    document.getElementById("residueBar").textContent = "Click any residue in the structure to inspect it.";
    viewer.zoomTo({}, 600); // fly back out to the whole protein
    viewer.render();
    return;
  }

  highlightedDomain = { accession: entry.accession, start: fragment.start, end: fragment.end };
  focusHelix(null);
  reapplyDomainHighlight();
  requestHelixDraw();

  document.querySelectorAll(`[data-domain-key="${entry.accession}:${fragment.start}-${fragment.end}"]`)
    .forEach(el => el.classList.add("active"));

  const span = fragment.end - fragment.start + 1;
  const total = Number(currentProteinLength) || 0;
  const coversMost = total > 0 && span / total > 0.8;

  document.getElementById("residueBar").innerHTML =
    `<strong>${escapeHtml(entry.name)}</strong> · ${escapeHtml(entry.displayId ?? entry.accession)} · ` +
    (fragment.start === fragment.end ? `residue ${fragment.start}` : `residues ${fragment.start}-${fragment.end}`) + ` in color, rest greyed out` +
    (coversMost ? ` · note: this entry spans ~${Math.round((span / total) * 100)}% of the protein` : "") +
    ` · click again to clear`;

  // Fly the camera to the highlighted residues
  const zoomPad = fragment.end - fragment.start < 12 ? 6 : 0;
  viewer.zoomTo({ resi: `${Math.max(1, fragment.start - zoomPad)}-${fragment.end + zoomPad}` }, 600);
  viewer.render();

  document.getElementById("viewer")?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function toggleSpin() {
  spinning = document.getElementById("spinToggle").checked;
  if (viewer) viewer.spin(spinning ? "y" : false);
}

function resetView() { if (viewer && model) { viewer.zoomTo(); viewer.render(); } }
function zoomIn() { if (viewer && model) { viewer.zoom(1.2, 200); viewer.render(); } }
function zoomOut() { if (viewer && model) { viewer.zoom(0.8, 200); viewer.render(); } }

function plddtColor(b) {
  if (b > 90) return "#0053D6";
  if (b > 70) return "#65CBF3";
  if (b > 50) return "#FFDB13";
  return "#FF7D45";
}

function downloadPDB() {
  if (!currentPdbData) return;
  const blob = new Blob([currentPdbData], { type: "chemical/x-pdb" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${currentGeneName || "structure"}.pdb`;
  a.click();
}

function downloadPNG() {
  if (!viewer || !model) return;
  const uri = viewer.pngURI();
  const a = document.createElement("a");
  a.href = uri;
  a.download = `${currentGeneName || "structure"}.png`;
  a.click();
}


/* ---------------------------------------------------------------------------
   Extra sections: recent searches, disease variants, partners, expression
--------------------------------------------------------------------------- */

function searchGene(name) {
  document.getElementById("geneInput").value = name;
  window.scrollTo({ top: 0, behavior: "smooth" });
  loadGene();
}

function getRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(list) ? list.filter(g => typeof g === "string") : [];
  } catch { return []; }
}

function addRecent(gene) {
  const list = [gene, ...getRecent().filter(g => g !== gene)].slice(0, MAX_RECENT);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* ignore */ }
  renderRecent();
}

function renderRecent() {
  const row = document.getElementById("recentRow");
  if (!row) return;
  const list = getRecent();
  row.hidden = list.length === 0;
  row.innerHTML = list.length
    ? `<span class="control-label">RECENT</span>` +
      list.map(g => `<button type="button" class="gene-chip" data-gene="${escapeHtml(g)}">${escapeHtml(g)}</button>`).join("")
    : "";
}

function resetExtraSections() {
  ["variantSection", "partnerSection", "exprSection"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
  ["variantMeta", "variantHint", "partnerMeta", "exprMeta"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = "";
  });
  ["variantMap", "variantScale", "variantList", "partnerList", "exprList", "exprHint"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = "";
  });
  const more = document.getElementById("variantMore");
  if (more) { more.hidden = true; more.dataset.expanded = "false"; }
}

function loadExtras(gene, accession, length, requestId, signal) {
  runExtra("variant", "disease variants", () => fetchDiseaseVariants(accession, signal), v => renderVariants(v, length), requestId);
  runExtra("partner", "interaction partners", () => fetchPartners(gene, signal), renderPartners, requestId);
  runExtra("expr", "tissue expression", () => fetchExpression(gene, signal), rows => renderExpression(rows, gene), requestId);
}

async function runExtra(prefix, label, fetcher, renderer, requestId) {
  const section = document.getElementById(`${prefix}Section`);
  const meta = document.getElementById(`${prefix}Meta`);
  if (!section || !meta) return;
  section.hidden = false;
  meta.textContent = `Loading ${label}…`;
  try {
    const data = await fetcher();
    if (isCurrentRequest(requestId)) renderer(data);
  } catch (e) {
    if (e.name === "AbortError" || !isCurrentRequest(requestId)) return;
    console.error(`${label} failed:`, e);
    meta.textContent = "";
    const target = document.getElementById(prefix === "partner" ? "partnerList" : `${prefix}List`);
    if (target) target.innerHTML = `<div class="error-note">Couldn't load ${label} right now. The rest of the gene result is unaffected.</div>`;
  }
}

/* ---- Disease variants (EBI Proteins API: UniProt + ClinVar) ---- */

async function fetchDiseaseVariants(accession, signal) {
  const key = cacheKey("variants", accession);
  const cached = cacheGet(key);
  if (cached) return cached;

  const res = await apiFetch(
    `https://www.ebi.ac.uk/proteins/api/variation/${encodeURIComponent(accession)}`,
    { headers: { Accept: "application/json" } },
    { signal }
  );
  const data = await res.json();
  const byChange = new Map();

  (data.features || []).forEach(f => {
    const pos = Number(f.begin);
    if (!Number.isFinite(pos) || pos < 1) return;

    const sigs = (f.clinicalSignificances || [])
      .map(c => String(c.type || ""))
      .filter(t => /pathogenic/i.test(t) && !/conflicting|benign/i.test(t));
    const diseases = (f.association || [])
      .filter(a => a.disease && a.name)
      .map(a => String(a.name));
    if (!sigs.length && !diseases.length) return;

    const wt = String(f.wildType || "");
    const mt = String(f.alternativeSequence ?? f.mutatedType ?? "");
    const rs = (f.xrefs || []).map(x => String(x.id || "")).find(id => /^rs\d+$/i.test(id)) || "";
    const k = `${pos}:${wt}>${mt}`;

    const v = byChange.get(k) || { pos, wt, mt, sigs: new Set(), diseases: new Set(), rs: "" };
    sigs.forEach(t => v.sigs.add(t));
    diseases.forEach(d => v.diseases.add(d));
    if (!v.rs && rs) v.rs = rs;
    byChange.set(k, v);
  });

  const variants = [...byChange.values()].map(v => {
    const sigs = [...v.sigs];
    let significance = "Disease-associated (UniProt)";
    if (sigs.some(t => /^pathogenic$/i.test(t.trim()))) significance = "Pathogenic";
    else if (sigs.some(t => /likely pathogenic/i.test(t))) significance = "Likely pathogenic";
    else if (sigs.length) significance = sigs[0];
    return { pos: v.pos, wt: v.wt, mt: v.mt, rs: v.rs, significance, diseases: [...v.diseases] };
  }).sort((a, b) => a.pos - b.pos);

  cacheSet(key, variants);
  return variants;
}

function variantLabel(v) {
  const short = s => (s.length > 4 ? s.slice(0, 4) + "…" : s);
  return `${short(v.wt) || "?"}${v.pos}${short(v.mt) || "?"}`;
}

function highlightVariant(v, el) {
  const label = variantLabel(v);
  highlightDomain(
    {
      accession: `VAR-${v.pos}-${v.wt}-${v.mt}`,
      displayId: v.rs || v.significance,
      name: v.diseases[0] ? `${label} · ${v.diseases[0]}` : label
    },
    { start: v.pos, end: v.pos },
    el
  );
}

function renderVariants(variants, proteinLength) {
  const meta = document.getElementById("variantMeta");
  const map = document.getElementById("variantMap");
  const scale = document.getElementById("variantScale");
  const list = document.getElementById("variantList");
  const hint = document.getElementById("variantHint");
  map.innerHTML = "";
  scale.innerHTML = "";
  list.innerHTML = "";
  hint.textContent = "";

  helixData.variants = variants || [];
  requestHelixDraw();

  if (!variants?.length) {
    map.style.display = "none";
    meta.textContent = "No pathogenic or disease-associated variants are listed for this protein.";
    return;
  }
  map.style.display = "";

  const length = Number(proteinLength) || Math.max(1, ...variants.map(v => v.pos));
  const positions = new Set(variants.map(v => v.pos)).size;
  meta.textContent = `${variants.length} pathogenic / disease-associated variant${variants.length === 1 ? "" : "s"} at ${positions} position${positions === 1 ? "" : "s"} · sources: UniProt, ClinVar`;

  const track = document.createElement("div");
  track.className = "domain-track";
  map.appendChild(track);
  wireMapToHelix(map, track, length, ".variant-tick");

  variants.forEach(v => {
    const tick = document.createElement("div");
    tick.className = "variant-tick";
    tick.style.left = `${Math.max(0, Math.min(100, ((v.pos - 0.5) / length) * 100))}%`;
    tick.dataset.domainKey = `VAR-${v.pos}-${v.wt}-${v.mt}:${v.pos}-${v.pos}`;
    tick.tabIndex = 0;
    tick.setAttribute("role", "button");
    tick.title = `${variantLabel(v)} · ${v.significance}${v.diseases[0] ? " · " + v.diseases[0] : ""}`;
    tick.setAttribute("aria-label", `${tick.title}. Click to show on the 3D structure.`);
    tick.addEventListener("click", () => highlightVariant(v, tick));
    tick.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); highlightVariant(v, tick); }
    });
    track.appendChild(tick);
  });

  const s1 = document.createElement("span"); s1.textContent = "1 aa";
  const s2 = document.createElement("span"); s2.textContent = `${length} aa`;
  scale.append(s1, s2);

  const cards = variants.slice(0, MAX_VARIANT_CARDS);
  cards.forEach((v, i) => {
    const item = document.createElement("div");
    item.className = "interpro-item clickable" + (i >= VARIANTS_COLLAPSED ? " variant-extra" : "");
    item.hidden = i >= VARIANTS_COLLAPSED;
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    item.dataset.domainKey = `VAR-${v.pos}-${v.wt}-${v.mt}:${v.pos}-${v.pos}`;
    const rsLink = v.rs
      ? `<a href="https://www.ncbi.nlm.nih.gov/snp/${encodeURIComponent(v.rs)}" target="_blank" rel="noopener">${escapeHtml(v.rs)}</a>`
      : `<span class="interpro-type">no rsID</span>`;
    item.innerHTML = `
      <div class="interpro-item-head">
        ${rsLink}
        <span class="interpro-type">${escapeHtml(v.significance)}</span>
      </div>
      <div class="interpro-name">${escapeHtml(variantLabel(v))}${v.diseases.length ? " · " + escapeHtml(v.diseases.join("; ")) : ""}</div>
      <div class="interpro-range">residue ${v.pos}</div>
    `;
    item.addEventListener("click", e => {
      if (e.target.closest("a")) return;
      highlightVariant(v, item);
    });
    item.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); highlightVariant(v, item); }
    });
    list.appendChild(item);
  });

  const more = document.getElementById("variantMore");
  if (more) {
    more.hidden = cards.length <= VARIANTS_COLLAPSED;
    more.dataset.expanded = "false";
    more.dataset.count = String(cards.length);
    more.textContent = `See more (${cards.length - VARIANTS_COLLAPSED} more)`;
  }

  hint.textContent = (variants.length > MAX_VARIANT_CARDS
    ? `Cards list the first ${MAX_VARIANT_CARDS} of ${variants.length} by position · every variant is marked on the track · `
    : "") + "Click a tick or card to show that residue on the 3D structure.";
}

function toggleVariantCards() {
  const more = document.getElementById("variantMore");
  if (!more) return;
  const expand = more.dataset.expanded !== "true";
  document.querySelectorAll("#variantList .variant-extra").forEach(el => { el.hidden = !expand; });
  more.dataset.expanded = String(expand);
  const hiddenCount = Number(more.dataset.count || 0) - VARIANTS_COLLAPSED;
  more.textContent = expand ? "See less" : `See more (${hiddenCount} more)`;
  if (!expand) document.getElementById("variantSection")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ---- Interaction partners (STRING) ---- */

async function fetchPartners(gene, signal) {
  const key = cacheKey("string", gene);
  const cached = cacheGet(key);
  if (cached) return cached;

  const url = `https://string-db.org/api/json/interaction_partners?identifiers=${encodeURIComponent(gene)}&species=9606&limit=12&caller_identity=gene-explorer`;
  const res = await apiFetch(url, {}, { signal });
  const data = await res.json();
  const seen = new Set();
  const partners = (Array.isArray(data) ? data : [])
    .map(r => ({ name: String(r.preferredName_B || ""), score: Number(r.score) }))
    .filter(p => p.name && p.name.toUpperCase() !== gene && Number.isFinite(p.score))
    .sort((a, b) => b.score - a.score)
    .filter(p => (seen.has(p.name) ? false : seen.add(p.name)))
    .slice(0, 10);

  cacheSet(key, partners);
  return partners;
}

function renderPartners(partners) {
  const meta = document.getElementById("partnerMeta");
  const list = document.getElementById("partnerList");
  list.innerHTML = "";
  if (!partners?.length) {
    meta.textContent = "No interaction partners found in STRING for this gene.";
    return;
  }
  meta.textContent = "Top functional partners from STRING (combined score 0–1) · click one to open it in a new tab";
  const base = window.location.pathname;
  list.innerHTML = partners.map(p =>
    `<a class="gene-chip" href="${base}?gene=${encodeURIComponent(p.name)}" target="_blank" rel="noopener" title="STRING combined score ${p.score.toFixed(3)}">` +
    `${escapeHtml(p.name)}<span class="chip-score">${p.score.toFixed(2)}</span></a>`
  ).join("");
}

/* ---- Tissue expression (GTEx) ---- */

async function fetchExpression(gene, signal) {
  const key = cacheKey("gtex", gene);
  const cached = cacheGet(key);
  if (cached) return cached;

  const refRes = await apiFetch(
    `https://gtexportal.org/api/v2/reference/gene?geneId=${encodeURIComponent(gene)}`,
    { headers: { Accept: "application/json" } },
    { signal }
  );
  const refData = await refRes.json();
  const gencodeId = (refData.data || []).find(g => String(g.geneSymbol || "").toUpperCase() === gene)?.gencodeId
    || refData.data?.[0]?.gencodeId;
  if (!gencodeId) { cacheSet(key, []); return []; }

  const expRes = await apiFetch(
    `https://gtexportal.org/api/v2/expression/medianGeneExpression?gencodeId=${encodeURIComponent(gencodeId)}&datasetId=gtex_v8`,
    { headers: { Accept: "application/json" } },
    { signal }
  );
  const expData = await expRes.json();
  const rows = (expData.data || [])
    .map(r => ({
      tissue: String(r.tissueSiteDetailId || "").replace(/_+/g, " ").replace(/\s+-\s+/g, " – ").trim(),
      median: Number(r.median)
    }))
    .filter(r => r.tissue && Number.isFinite(r.median))
    .sort((a, b) => b.median - a.median);

  cacheSet(key, rows);
  return rows;
}

function renderExpression(rows, gene) {
  const meta = document.getElementById("exprMeta");
  const list = document.getElementById("exprList");
  const hint = document.getElementById("exprHint");
  list.innerHTML = "";
  hint.innerHTML = "";
  if (!rows?.length) {
    meta.textContent = "No GTEx expression data found for this gene.";
    return;
  }
  const top = rows.slice(0, 10);
  const max = Math.max(...top.map(r => r.median), 0.0001);
  meta.textContent = `Median expression across ${rows.length} GTEx tissues (TPM) · top ${top.length} shown`;
  list.innerHTML = top.map(r => `
    <div class="expr-row">
      <div class="expr-label">${escapeHtml(r.tissue)} · ${r.median.toFixed(1)} TPM</div>
      <div class="ss-bar-track"><div class="ss-bar-fill" style="width:${((r.median / max) * 100).toFixed(1)}%;background:var(--accent)"></div></div>
    </div>
  `).join("");
  hint.innerHTML = `Full profile: <a class="ext-link" href="https://gtexportal.org/home/gene/${encodeURIComponent(gene)}" target="_blank" rel="noopener">GTEx Portal →</a>`;
}


/* ---------------------------------------------------------------------------
   Jump navigation: a live minimap rail in the right margin (wide screens)
   and a floating section pill (narrow screens). Dots sit at each section's
   real position on the page and re-flow as sections load; the outlined
   window shows exactly which slice of the page is on screen.
--------------------------------------------------------------------------- */

(function initJumpNav() {
  const SECTIONS = [
    ["viewer", "Structure"],
    ["info", "Overview"],
    ["interproSection", "Domains"],
    ["locationSection", "Location"],
    ["variantSection", "Variants"],
    ["partnerSection", "Partners"],
    ["exprSection", "Expression"],
    [".learn-section", "Read more"]
  ];
  const MIN_GAP = 22;
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  let rail, railInner, fill, win, zone, pill, pillLabel, pillBar, menu;
  let nearItem = null;
  let drag = null;
  const NEAR_PX = 36;      // how close (vertically) the cursor must be to a dot to reveal its name
  let items = [];
  let itemsKey = "";
  let activeSel = null;
  let ticking = false;
  let layoutQueued = false;

  // DNA "decode" effect: the label starts as a flickering A/T/G/C strand, then
  // types itself out left to right into the section name.
  const BASES = "ATGC";
  const decoding = new WeakMap();
  function decode(el, text) {
    if (!el) return;
    const prev = decoding.get(el);
    if (prev) clearTimeout(prev);
    if (reduceMotion) { el.textContent = text; return; }
    const HOLD = 160;   // ms of pure DNA before typing starts
    const PER = 42;     // ms per typed letter
    const FLICKER = 55; // ms between base reshuffles
    const start = performance.now();
    let lastShuffle = -1, strand = "";
    const tick = () => {
      const t = performance.now() - start;
      const typed = t < HOLD ? 0 : Math.min(text.length, Math.floor((t - HOLD) / PER) + 1);
      const shuffle = Math.floor(t / FLICKER);
      if (shuffle !== lastShuffle) {
        lastShuffle = shuffle;
        strand = Array.from(text, ch => (ch === " " ? " " : BASES[(Math.random() * 4) | 0])).join("");
      }
      if (typed >= text.length) {
        el.textContent = text;
        decoding.delete(el);
        return;
      }
      el.innerHTML = `${escapeHtml(text.slice(0, typed))}<span class="dna-caret"></span><span class="dna">${strand.slice(typed)}</span>`;
      decoding.set(el, setTimeout(tick, 30));
    };
    tick();
  }

  const find = sel => (sel.startsWith(".") ? document.querySelector(sel) : document.getElementById(sel));
  const isShown = node => node && !node.hidden && node.getClientRects().length > 0 && node.getBoundingClientRect().height > 0;
  const docHeight = () => Math.max(document.documentElement.scrollHeight, 1);

  function build() {
    rail = document.createElement("nav");
    rail.className = "jump-rail";
    rail.setAttribute("aria-label", "Jump to section");
    rail.hidden = true;
    rail.innerHTML = `<div class="jr-inner"><div class="jr-track"></div><div class="jr-fill"></div><div class="jr-window"></div><div class="jr-zone"></div></div>`;
    railInner = rail.querySelector(".jr-inner");
    fill = rail.querySelector(".jr-fill");
    win = rail.querySelector(".jr-window");
    zone = rail.querySelector(".jr-zone");
    wireZone();

    pill = document.createElement("div");
    pill.className = "jump-pill";
    pill.hidden = true;
    pill.innerHTML = `
      <div class="jp-menu" hidden></div>
      <button type="button" class="jp-button" aria-haspopup="true" aria-expanded="false" aria-label="Jump to section">
        <span class="jp-dot"></span><span class="jp-label">Structure</span><span class="jp-caret">&#9662;</span>
        <span class="jp-bar"></span>
      </button>`;
    menu = pill.querySelector(".jp-menu");
    pillLabel = pill.querySelector(".jp-label");
    pillBar = pill.querySelector(".jp-bar");
    const pillButton = pill.querySelector(".jp-button");
    pillButton.addEventListener("click", e => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
      pillButton.setAttribute("aria-expanded", String(!menu.hidden));
    });
    document.addEventListener("click", e => {
      if (!pill.contains(e.target)) { menu.hidden = true; pillButton.setAttribute("aria-expanded", "false"); }
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") { menu.hidden = true; pillButton.setAttribute("aria-expanded", "false"); }
    });

    document.body.append(rail, pill);
  }

  /* Pointer handling for the whole rail area: the nearest dot's name appears as
     soon as the cursor is anywhere close; the glowing window can be dragged
     like a scrollbar; a click jumps to the nearest section (or to that point). */
  function railY(e) { return e.clientY - railInner.getBoundingClientRect().top; }

  function nearest(y, maxDist = NEAR_PX) {
    let best = null, bestD = Infinity;
    items.forEach(it => { const d = Math.abs(it.y - y); if (d < bestD) { bestD = d; best = it; } });
    return bestD <= maxDist ? best : null;
  }

  function onWindow(y) {
    const top = parseFloat(win.style.top) || 0;
    const h = parseFloat(win.style.height) || 0;
    return y >= top - 6 && y <= top + h + 6;
  }

  function setNear(it) {
    if (it === nearItem) return;
    nearItem?.item.classList.remove("near");
    nearItem = it;
    rail.classList.toggle("has-near", !!it);
    if (it) {
      it.item.classList.add("near");
      decode(it.labelEl, it.label);
    }
  }

  function wireZone() {
    zone.addEventListener("pointermove", e => {
      const y = railY(e);
      if (drag) {
        const dy = e.clientY - drag.startY;
        if (Math.abs(dy) > 3) drag.moved = true;
        if (drag.moved && drag.grab) {
          const railH = railInner.clientHeight || 1;
          window.scrollTo({ top: drag.startScroll + dy * (docHeight() / railH), behavior: "auto" });
        }
        if (drag.grab) return;
      }
      setNear(nearest(y));
      rail.classList.toggle("on-window", onWindow(y));
    });
    zone.addEventListener("pointerleave", () => {
      if (drag) return;
      setNear(null);
      rail.classList.remove("on-window");
    });
    zone.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      const y = railY(e);
      drag = { startY: e.clientY, startScroll: window.scrollY, moved: false, grab: onWindow(y) };
      zone.setPointerCapture(e.pointerId);
      if (drag.grab) rail.classList.add("dragging");
      e.preventDefault();
    });
    const end = e => {
      if (!drag) return;
      const y = railY(e);
      if (!drag.moved) {
        const it = nearest(y, 16);
        if (it) go(it);
        else {
          const railH = railInner.clientHeight || 1;
          const frac = Math.min(1, Math.max(0, y / railH));
          window.scrollTo({ top: frac * docHeight() - window.innerHeight / 2, behavior: reduceMotion ? "auto" : "smooth" });
        }
      }
      drag = null;
      rail.classList.remove("dragging");
      try { zone.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };
    zone.addEventListener("pointerup", end);
    zone.addEventListener("pointercancel", end);
  }

  function go(it) {
    const top = it.node.getBoundingClientRect().top + window.scrollY - 20;
    window.scrollTo({ top, behavior: reduceMotion ? "auto" : "smooth" });
    menu.hidden = true;
  }

  function layout() {
    layoutQueued = false;
    const ready = typeof model !== "undefined" && model !== null;
    rail.hidden = !ready;
    pill.hidden = !ready;
    if (!ready) { menu.hidden = true; return; }

    const found = SECTIONS
      .map(([sel, label]) => ({ sel, label, node: find(sel) }))
      .filter(s => isShown(s.node));
    const key = found.map(s => s.sel).join("|");

    if (key !== itemsKey) {
      itemsKey = key;
      railInner.querySelectorAll(".jr-item").forEach(n => n.remove());
      nearItem = null;
      rail.classList.remove("has-near");
      menu.innerHTML = "";
      items = found.map(s => {
        const item = document.createElement("div");
        item.className = "jr-item";
        item.innerHTML = `<button type="button" class="jr-dot" aria-label="Jump to ${s.label}"></button><span class="jr-label">${s.label}</span>`;
        const dot = item.querySelector(".jr-dot");
        const label = item.querySelector(".jr-label");
        dot.addEventListener("focus", () => decode(label, s.label));
        railInner.appendChild(item);

        const option = document.createElement("button");
        option.type = "button";
        option.className = "jp-option";
        option.textContent = s.label;
        menu.appendChild(option);

        const it = { ...s, item, dot, labelEl: label, option, top: 0, y: 0 };
        dot.addEventListener("click", () => go(it));
        option.addEventListener("click", () => go(it));
        return it;
      });
      activeSel = null;
    } else {
      items.forEach((it, i) => { it.node = found[i].node; });
    }

    // Stretch the hover zone left into the empty margin, but never over the content
    const page = document.querySelector(".page");
    if (page && !rail.hidden) {
      const gap = rail.getBoundingClientRect().left - page.getBoundingClientRect().right;
      zone.style.left = `-${Math.round(Math.min(140, Math.max(24, gap - 16)))}px`;
    }

    const docH = docHeight();
    const railH = railInner.clientHeight || 1;
    let last = -Infinity;
    items.forEach(it => {
      it.top = it.node.getBoundingClientRect().top + window.scrollY;
      const y = Math.min(railH, Math.max((it.top / docH) * railH, last + MIN_GAP));
      it.y = y;
      last = y;
      it.item.style.top = `${y}px`;
    });
    update();
  }

  function update() {
    ticking = false;
    if (rail.hidden || !items.length) return;
    const docH = docHeight();
    const railH = railInner.clientHeight || 1;
    const y = window.scrollY;
    const vh = window.innerHeight;

    win.style.top = `${(y / docH) * railH}px`;
    win.style.height = `${Math.max(12, (vh / docH) * railH)}px`;

    // Active section = the one taking up the most of the screen right now
    let current = items[0], bestVisible = -1;
    items.forEach((it, i) => {
      const end = i + 1 < items.length ? items[i + 1].top : docH;
      const visible = Math.min(end, y + vh) - Math.max(it.top, y);
      if (visible > bestVisible) { bestVisible = visible; current = it; }
    });
    if (y + vh >= docH - 4) current = items[items.length - 1];

    fill.style.height = `${current.y}px`;
    items.forEach(it => {
      it.item.classList.toggle("active", it === current);
      it.item.classList.toggle("passed", it.top < current.top);
      it.option.classList.toggle("active", it === current);
    });

    const progress = Math.min(1, Math.max(0, y / Math.max(1, docH - vh)));
    pillBar.style.transform = `scaleX(${progress})`;

    if (current.sel !== activeSel) {
      activeSel = current.sel;
      decode(current.labelEl, current.label);
      if (!pill.hidden) decode(pillLabel, current.label);
    }
  }

  const queueUpdate = () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } };
  const queueLayout = () => { if (!layoutQueued) { layoutQueued = true; requestAnimationFrame(layout); } };

  window.addEventListener("load", () => {
    build();
    window.addEventListener("scroll", queueUpdate, { passive: true });
    window.addEventListener("resize", queueLayout);
    const page = document.querySelector(".page");
    if (page) {
      if ("ResizeObserver" in window) new ResizeObserver(queueLayout).observe(page);
      new MutationObserver(queueLayout).observe(page, { attributes: true, attributeFilter: ["hidden", "style"], subtree: true, childList: true });
    }
    queueLayout();
  });
})();


/* ---------------------------------------------------------------------------
   Reverse link: clicking a residue on the structure, or an empty spot on the
   domain/variant map, lights up that residue's codon on the DNA helix.
--------------------------------------------------------------------------- */

function codonInfo(res) {
  const cds = helixData.cds;
  if (!cds || !Number.isFinite(res) || res < 1 || res * 3 > cds.length) return null;
  const codon = cds.slice((res - 1) * 3, res * 3);
  const aa = translateCodon(codon);
  return { res, codon, aa, aa3: AA3[aa] || aa, cStart: (res - 1) * 3 + 1, cEnd: res * 3 };
}

function wireMapToHelix(map, track, proteinLength, markerSelector) {
  map.classList.add("helix-linked");
  map.addEventListener("click", e => {
    if (e.target.closest(markerSelector)) return; // bars/ticks keep their own behaviour
    const r = track.getBoundingClientRect();
    if (!r.width) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const res = Math.min(proteinLength, Math.max(1, Math.round(frac * proteinLength + 0.5)));
    const codon = codonInfo(res);
    document.getElementById("residueBar").innerHTML = codon
      ? `<strong>Residue ${res} · ${escapeHtml(codon.aa3)}</strong> · codon ${codon.codon} (c.${codon.cStart}–${codon.cEnd}) · lit on the DNA helix`
      : `<strong>Residue ${res}</strong>`;
    focusHelix(res, "map");
  });
}


/* ---------------------------------------------------------------------------
   Coding sequence (CDS) for the helix: Ensembl transcript linked from the
   UniProt entry (falls back to Ensembl's canonical transcript), checked by
   translating it and comparing with the UniProt protein sequence.
--------------------------------------------------------------------------- */

const CODON_TABLE = "FFLLSSSSYY**CC*WLLLLPPPPHHQQRRRRIIIMTTTTNNKKSSRRVVVVAAAADDEEGGGG";
const BASE_INDEX = { T: 0, C: 1, A: 2, G: 3 };
const AA3 = {
  A: "Ala", R: "Arg", N: "Asn", D: "Asp", C: "Cys", Q: "Gln", E: "Glu", G: "Gly", H: "His", I: "Ile",
  L: "Leu", K: "Lys", M: "Met", F: "Phe", P: "Pro", S: "Ser", T: "Thr", W: "Trp", Y: "Tyr", V: "Val", "*": "Stop"
};
const COMPLEMENT = { A: "T", T: "A", G: "C", C: "G", N: "N" };

function translateCodon(codon) {
  if (codon.length !== 3) return "X";
  const [a, b, c] = codon.split("").map(ch => BASE_INDEX[ch]);
  if (a === undefined || b === undefined || c === undefined) return "X";
  return CODON_TABLE[a * 16 + b * 4 + c];
}

function translate(seq) {
  let out = "";
  for (let i = 0; i + 2 < seq.length; i += 3) out += translateCodon(seq.slice(i, i + 3));
  return out;
}

function pickEnsemblTranscript(fullData, accession) {
  const refs = (fullData?.uniProtKBCrossReferences || []).filter(x => x.database === "Ensembl" && /^ENST/.test(x.id || ""));
  const canonical = refs.find(x => !x.isoformId || x.isoformId === `${accession}-1`) || refs[0];
  return canonical?.id || "";
}

async function loadCds(gene, accession, fullData, requestId, signal) {
  const fail = (why) => {
    if (!isCurrentRequest(requestId)) return;
    helixData.cdsState = "failed";
    console.warn(`Coding sequence unavailable for ${gene}:`, why);
    requestHelixDraw();
  };
  helixData.cdsState = "loading";
  try {
    const key = cacheKey("cds", accession);
    let rec = cacheGet(key);
    if (!rec) {
      let tid = pickEnsemblTranscript(fullData, accession);
      if (!tid) {
        const res = await apiFetch(
          `https://rest.ensembl.org/lookup/symbol/homo_sapiens/${encodeURIComponent(gene)}?content-type=application/json`,
          { headers: { Accept: "application/json" } }, { signal }
        );
        tid = (await res.json()).canonical_transcript || "";
      }
      tid = tid.split(".")[0];
      if (!tid) { fail("no Ensembl transcript found"); return; }
      const res = await apiFetch(
        `https://rest.ensembl.org/sequence/id/${encodeURIComponent(tid)}?type=cds&content-type=application/json`,
        { headers: { Accept: "application/json" } }, { signal }
      );
      const seq = String((await res.json()).seq || "").toUpperCase().replace(/[^ACGTN]/g, "");
      if (seq.length < 3) { fail(`Ensembl returned no CDS for ${tid}`); return; }
      rec = { transcript: tid, seq };
      cacheSet(key, rec);
    }
    if (!isCurrentRequest(requestId)) return;
    const protein = String(fullData?.sequence?.value || "").toUpperCase();
    const translated = translate(rec.seq).replace(/\*$/, "");
    helixData.cds = rec.seq;
    helixData.transcript = rec.transcript;
    helixData.cdsMatches = protein ? translated === protein : null;
    helixData.cdsState = "ok";
    requestHelixDraw();
  } catch (e) {
    if (e.name !== "AbortError") fail(e);
  }
}


/* ---------------------------------------------------------------------------
   Left-margin DNA helix, drawn from the gene's real coding sequence.
   - Geometry follows B-DNA: 10.5 bp per turn, rise:diameter ≈ 3.4:20, and the
     two backbones offset so the major and minor grooves show.
   - Each rung is one real base pair, coloured by base (A, T, G, C).
   - The helix screws along the CDS as you scroll: top of page = start codon,
     bottom = stop codon. Highlighting a domain/variant/residue glides it to
     that region's codons.
   - Domains tint the backbone amber, pathogenic variants mark their codon,
     the highlighted region glows red.
   - Hover a base pair for its c. position, codon and amino acid; click it to
     highlight that residue (or its domain/variant) on the structure.
   Before a gene loads it's a plain grey helix. Hidden on smaller screens; the
   page works the same without it.
--------------------------------------------------------------------------- */

(function initHelix() {
  const W = 88;
  const R = 22;                          // radius (diameter ≈ 20 Å)
  const BP_PER_TURN = 10.5;
  const STEP = (2 * R) * (3.4 / 20);     // rise per bp, scaled to the diameter
  const GROOVE = Math.PI * 2 * 0.38;     // backbone offset → minor (narrow) and major (wide) grooves
  const TOP = 8;
  const BASE_COLORS = { A: "#78bfa0", T: "#e07a5f", G: "#e8a94a", C: "#8aa7d9", N: "#85837a" };
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const wide = window.matchMedia("(min-width: 1341px)");

  let wrap, canvas, ctx, tipMain, tipSub, legend, H = 0, raf = 0, lastFrame = 0;
  let offset = 0, spin = 0, hoverBp = -1, flags = null, varByRes = new Map(), domByRes = [];
  let lastCaption = "";
  let focus = null; // { res, source, y0 } — a single residue lit from the structure or a map
  let manual = null; // { offset, y0 } — set by the up/down buttons
  let upBtn, downBtn;

  const visibleBp = () => Math.max(1, Math.floor((H - TOP * 2) / STEP));

  function rebuildFlags() {
    const L = helixData.length;
    flags = new Uint8Array(L + 2);
    domByRes = new Array(L + 2);
    varByRes = new Map();
    helixData.domains.forEach(d => {
      for (let r = Math.max(1, d.fragment.start); r <= Math.min(L, d.fragment.end); r++) {
        flags[r] |= 1;
        if (!domByRes[r]) domByRes[r] = d;
      }
    });
    helixData.variants.forEach(v => {
      if (v.pos >= 1 && v.pos <= L) { flags[v.pos] |= 2; if (!varByRes.has(v.pos)) varByRes.set(v.pos, v); }
    });
  }

  function targetOffset() {
    const len = helixData.cds.length;
    const n = visibleBp();
    const maxOff = Math.max(0, len - n);
    if (manual) return Math.min(maxOff, Math.max(0, manual.offset));
    if (focus) {
      const mid = (focus.res - 1) * 3 + 1.5;
      return Math.min(maxOff, Math.max(0, mid - n / 2));
    }
    if (highlightedDomain) {
      const a = (highlightedDomain.start - 1) * 3;
      const b = highlightedDomain.end * 3;
      const t = b - a <= n ? (a + b) / 2 - n / 2 : a - 3;
      return Math.min(maxOff, Math.max(0, t));
    }
    const docH = document.documentElement.scrollHeight;
    const progress = Math.min(1, Math.max(0, window.scrollY / Math.max(1, docH - window.innerHeight)));
    return progress * maxOff;
  }

  function resize() {
    if (!wrap) return;
    const dpr = window.devicePixelRatio || 1;
    H = wrap.querySelector(".helix-stage").clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(performance.now(), true);
  }

  const yOf = t => TOP + (t - offset) * STEP;
  const angleOf = t => (t * Math.PI * 2) / BP_PER_TURN + spin;

  function draw(now, snap) {
    if (!ctx || !H) return;
    const hasSeq = !!helixData.cds;

    if (hasSeq) {
      const target = targetOffset();
      offset = snap || reduceMotion ? target : offset + (target - offset) * 0.12;
    } else {
      offset = window.scrollY / STEP * 0.25; // idle: drift with scroll
    }
    if (!reduceMotion) spin = now * 0.00025;

    ctx.clearRect(0, 0, W, H);
    const cx = W / 2;
    const first = Math.floor(offset) - 1;
    const last = first + visibleBp() + 3;

    // Backbones (sugar-phosphate), tinted amber across domains
    for (let s = 0; s < 2; s++) {
      const shift = s ? GROOVE : 0;
      let px = null, py = null;
      for (let t = first; t <= last; t += 0.25) {
        const y = yOf(t);
        const a = angleOf(t) + shift;
        const x = cx + R * Math.sin(a);
        const z = (Math.cos(a) + 1) / 2;
        if (px !== null && y > 0 && py < H) {
          const res = Math.floor(t / 3) + 1;
          const inDomain = hasSeq && flags && flags[res] & 1;
          ctx.strokeStyle = inDomain
            ? `rgba(232, 169, 74, ${0.25 + 0.6 * z})`
            : `rgba(133, 131, 122, ${0.12 + 0.45 * z})`;
          ctx.lineWidth = 1 + 1.1 * z;
          ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(x, y); ctx.stroke();
        }
        px = x; py = y;
      }
    }

    // Base pairs
    const cds = helixData.cds;
    for (let b = Math.max(0, first); b <= last; b++) {
      if (hasSeq && b >= cds.length) break;
      const y = yOf(b);
      if (y < 2 || y > H - 2) continue;
      const a1 = angleOf(b), a2 = a1 + GROOVE;
      const x1 = cx + R * Math.sin(a1), x2 = cx + R * Math.sin(a2);
      const depth = 0.35 + 0.65 * ((Math.cos(a1) + Math.cos(a2)) / 4 + 0.5);
      const xm = (x1 + x2) / 2;
      const res = Math.floor(b / 3) + 1;
      const f = hasSeq && flags ? flags[res] : 0;
      const lit = hasSeq && highlightedDomain && res >= highlightedDomain.start && res <= highlightedDomain.end;
      const hovered = hasSeq && b === hoverBp;
      const focused = hasSeq && focus && res === focus.res;

      ctx.globalAlpha = depth;
      if (hasSeq) {
        const base = cds[b], comp = COMPLEMENT[base] || "N";
        ctx.lineWidth = hovered ? 2.4 : 1.6;
        ctx.strokeStyle = hovered ? "#e8e6df" : BASE_COLORS[base];
        ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(xm, y); ctx.stroke();
        ctx.strokeStyle = hovered ? "#e8e6df" : BASE_COLORS[comp];
        ctx.beginPath(); ctx.moveTo(xm, y); ctx.lineTo(x2, y); ctx.stroke();
      } else {
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(133, 131, 122, 0.3)";
        ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
      }

      if (lit) {
        ctx.globalAlpha = 1;
        ctx.shadowColor = "#ff4d4d"; ctx.shadowBlur = 8;
        ctx.strokeStyle = "rgba(255, 77, 77, 0.85)"; ctx.lineWidth = 2.2;
        ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
        ctx.shadowBlur = 0;
      }
      if (focused) {
        const pulse = reduceMotion ? 1 : 0.65 + 0.35 * Math.sin(now / 160);
        ctx.globalAlpha = 1;
        ctx.shadowColor = "#e8a94a"; ctx.shadowBlur = 14 * pulse;
        ctx.strokeStyle = `rgba(255, 214, 140, ${0.75 + 0.25 * pulse})`; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(x1 - 3, y); ctx.lineTo(x2 + (x2 > x1 ? 3 : -3), y); ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.fillStyle = "#ffd68c";
        ctx.beginPath(); ctx.arc(x1, y, 2.6, 0, Math.PI * 2); ctx.arc(x2, y, 2.6, 0, Math.PI * 2); ctx.fill();
      }
      if (f & 2) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = lit ? "#ff4d4d" : "#e07a5f";
        ctx.beginPath(); ctx.arc(x1, y, 2.1, 0, Math.PI * 2); ctx.arc(x2, y, 2.1, 0, Math.PI * 2); ctx.fill();
      }
      // Mark the real start and stop codons when they scroll into view
      if (hasSeq && (b === 0 || b === cds.length - 3)) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#e8a94a";
        ctx.font = "500 7px 'JetBrains Mono', monospace";
        ctx.textBaseline = "middle";
        ctx.fillText(b === 0 ? "ATG" : "STOP", cx + R + 5, y + (b === 0 ? 0 : STEP));
      }
    }
    ctx.globalAlpha = 1;

    if (hoverBp < 0) idleCaption();
    updateButtons();
  }

  function setTip(main, sub, accent) {
    tipMain.textContent = main;
    tipSub.textContent = sub;
    tipMain.classList.toggle("accent", !!accent);
  }

  function idleCaption() {
    let main = "", sub = "", accent = false;
    const fc = focus && codonInfo(focus.res);
    if (fc) {
      main = `c.${fc.cStart}–${fc.cEnd} ${fc.codon} → ${fc.aa3}`;
      sub = `residue ${fc.res} · via ${focus.source === "structure" ? "structure" : "map"}`;
      accent = true;
    } else if (helixData.cds) {
      const top = Math.max(1, Math.round(offset) + 1);
      const bottom = Math.min(helixData.cds.length, top + visibleBp() - 1);
      main = `${helixData.gene} CDS · c.${top}–${bottom}`;
      sub = helixData.cdsMatches === false
        ? `${helixData.transcript} · isoform ≠ UniProt`
        : helixData.transcript;
    } else if (helixData.length) {
      main = helixData.cdsState === "failed"
        ? `${helixData.gene} · sequence unavailable`
        : `${helixData.gene} · loading sequence…`;
    }
    const caption = main + "|" + sub;
    if (caption !== lastCaption) { lastCaption = caption; setTip(main, sub, accent); }
    legend.hidden = !helixData.cds;
  }

  function bpAt(e) {
    const y = e.clientY - canvas.getBoundingClientRect().top;
    const b = Math.round(offset + (y - TOP) / STEP);
    return b >= 0 && b < helixData.cds.length ? b : -1;
  }

  function onMove(e) {
    if (!helixData.cds) return;
    const b = bpAt(e);
    if (b === hoverBp) return;
    hoverBp = b;
    if (b < 0) { onLeave(); return; }
    const cds = helixData.cds;
    const res = Math.floor(b / 3) + 1;
    const codon = cds.slice((res - 1) * 3, res * 3);
    const aa = translateCodon(codon);
    const v = varByRes.get(res);
    const d = domByRes[res];
    const extra = v ? ` · ${variantLabel(v)}` : d ? ` · ${d.entry.name}` : "";
    setTip(
      `c.${b + 1} ${cds[b]}–${COMPLEMENT[cds[b]] || "N"}`,
      `codon ${res} ${codon} → ${AA3[aa] || aa}${extra}`,
      true
    );
    lastCaption = "";
    canvas.style.cursor = res <= helixData.length ? "pointer" : "default";
    if (reduceMotion) draw(performance.now());
  }

  function onLeave() {
    hoverBp = -1;
    canvas.style.cursor = "default";
    lastCaption = "";
    draw(performance.now());
  }

  function onClick(e) {
    if (!helixData.cds) return;
    const b = bpAt(e);
    if (b < 0) return;
    const res = Math.floor(b / 3) + 1;
    if (res > helixData.length) return; // stop codon
    const v = varByRes.get(res);
    const d = domByRes[res];
    if (v) { highlightVariant(v, null); return; }
    if (d) { highlightDomain(d.entry, d.fragment, null); return; }
    const codon = helixData.cds.slice((res - 1) * 3, res * 3);
    const aa = translateCodon(codon);
    highlightDomain(
      { accession: `RES-${res}`, displayId: `codon ${codon}`, name: `${AA3[aa] || aa}${res}` },
      { start: res, end: res },
      null
    );
  }

  /* Up/down buttons: step one codon per click, hold to keep moving */
  function maxOffset() { return Math.max(0, helixData.cds.length - visibleBp()); }

  function step(dir) {
    if (!helixData.cds) return;
    const from = manual ? manual.offset : Math.round(offset);
    const next = Math.min(maxOffset(), Math.max(0, from + dir * 3));
    manual = { offset: next, y0: window.scrollY };
    focus = null;
    lastCaption = "";
    updateButtons();
    if (!raf) draw(performance.now(), true);
  }

  function updateButtons() {
    if (!upBtn) return;
    const show = !!helixData.cds;
    upBtn.hidden = downBtn.hidden = !show;
    wrap.querySelectorAll(".helix-end").forEach(el => { el.hidden = !show; });
    if (!show) return;
    const cur = manual ? manual.offset : Math.round(offset);
    upBtn.disabled = cur <= 0;
    downBtn.disabled = cur >= maxOffset();
  }

  function wireHold(btn, dir) {
    let delay = 0, repeat = 0;
    const stop = () => { clearTimeout(delay); clearInterval(repeat); };
    btn.addEventListener("pointerdown", e => {
      if (e.button !== 0 || btn.disabled) return;
      e.preventDefault();
      step(dir);
      delay = setTimeout(() => { repeat = setInterval(() => step(dir), 70); }, 350);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach(ev => btn.addEventListener(ev, stop));
    btn.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); step(dir); }
    });
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (now - lastFrame < 33) return;
    lastFrame = now;
    draw(now);
  }

  function syncRunning() {
    const shouldRun = wide.matches && !document.hidden && !reduceMotion;
    if (shouldRun && !raf) raf = requestAnimationFrame(loop);
    if (!shouldRun && raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  window.addEventListener("load", () => {
    wrap = document.createElement("div");
    wrap.className = "helix";
    wrap.innerHTML = `
      <div class="helix-end helix-end-top" hidden>5′ · start</div>
      <div class="helix-stage"><canvas aria-hidden="true"></canvas></div>
      <div class="helix-end helix-end-bottom" hidden>3′ · end</div>
      <div class="helix-tip"><div class="helix-tip-main"></div><div class="helix-tip-sub"></div></div>
      <div class="helix-nav">
        <button type="button" class="helix-btn" data-dir="-1" aria-label="Move toward the start (5′ end)" title="Toward the start (5′)" hidden>&#9650;</button>
        <button type="button" class="helix-btn" data-dir="1" aria-label="Move toward the end (3′ end)" title="Toward the end (3′)" hidden>&#9660;</button>
      </div>
      <div class="helix-legend" hidden>
        <span style="color:${BASE_COLORS.A}">A</span><span style="color:${BASE_COLORS.T}">T</span>
        <span style="color:${BASE_COLORS.G}">G</span><span style="color:${BASE_COLORS.C}">C</span>
      </div>`;
    document.body.appendChild(wrap);
    canvas = wrap.querySelector("canvas");
    ctx = canvas.getContext("2d");
    tipMain = wrap.querySelector(".helix-tip-main");
    tipSub = wrap.querySelector(".helix-tip-sub");
    legend = wrap.querySelector(".helix-legend");
    [upBtn, downBtn] = wrap.querySelectorAll(".helix-btn");
    wireHold(upBtn, -1);
    wireHold(downBtn, 1);

    focusHelix = (res, source) => {
      focus = res && codonInfo(res) ? { res, source, y0: window.scrollY } : null;
      if (res) manual = null;
      lastCaption = "";
      if (focus && !wide.matches) return;
      if (!raf) draw(performance.now(), reduceMotion);
    };
    // Scrolling away hands the helix back to scroll-following
    window.addEventListener("scroll", () => {
      if (focus && Math.abs(window.scrollY - focus.y0) > 160) { focus = null; lastCaption = ""; }
      if (manual && Math.abs(window.scrollY - manual.y0) > 160) { manual = null; lastCaption = ""; }
    }, { passive: true });

    requestHelixDraw = () => {
      rebuildFlags();
      if (!helixData.cds || highlightedDomain) manual = null;
      lastCaption = "";
      if (!raf) requestAnimationFrame(() => draw(performance.now(), true));
    };

    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);
    canvas.addEventListener("click", onClick);
    window.addEventListener("resize", resize);
    if (reduceMotion) window.addEventListener("scroll", () => draw(performance.now(), true), { passive: true });
    document.addEventListener("visibilitychange", syncRunning);
    wide.addEventListener?.("change", () => { resize(); syncRunning(); });

    rebuildFlags();
    resize();
    syncRunning();
  });
})();
