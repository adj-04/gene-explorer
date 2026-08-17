
"use strict";

let viewer = null;
let model = null;
let spinning = false;
let currentPdbData = "";
let currentGeneName = "";
let highlightedDomain = null;

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
  highlightedDomain = null;
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
});;

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
  meta.textContent = `${entries.length} InterPro entr${entries.length === 1 ? "y" : "ies"} · ${locatedEntries.length} with sequence coordinates · protein length ${length} aa`;

  const track = document.createElement("div");
  track.className = "domain-track";
  map.appendChild(track);

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

async function fetchGenomicLocation(geneId, signal) {
  if (!geneId || geneId === "-") return null;
  const key = cacheKey("ncbi-location", geneId);
  const cached = cacheGet(key);
  if (cached) return cached;
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=gene&id=${geneId}&retmode=json`;
  const res = await apiFetch(url, {}, { signal });
  const data = await res.json();
  const doc = data.result?.[geneId];
  if (!doc) return null;
  const gi = (doc.genomicinfo || [])[0];
  const chr = doc.chromosome || gi?.chrloc;
  if (!chr || !gi) return null;
  const a = parseInt(gi.chrstart, 10), b = parseInt(gi.chrstop, 10);
  if (isNaN(a) || isNaN(b)) return null;
  const loc = { chr: String(chr), mapLocation: doc.maplocation || "", start: Math.min(a,b), stop: Math.max(a,b) };
  cacheSet(key, loc);
  return loc;
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

  try {
    new Ideogram({
      container: "#ideoContainer",
      organism: "human",
      chrHeight: 300,
      rotatable: false,
      annotationsLayout: "overlay",
      annotationHeight: 6,
      annotations: annotation,
      onLoad: wireClickThrough
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
      document.getElementById("residueBar").innerHTML =
        `<strong>${escapeHtml(atom.resn)} ${escapeHtml(atom.resi)}</strong> · chain ${escapeHtml(atom.chain || "-")} · confidence (pLDDT): ${confidence}`;
    });

    const ss = computeSecondaryStructureStats();

    // The core result is usable even if enrichment APIs fail.
    let refsHtml = "No linked publications found.";
    let geneId = "-";
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
      const loc = await fetchGenomicLocation(geneId, signal);
      if (isCurrentRequest(requestId)) renderIdeogram(loc, gene, geneId);
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
      { label: "Function", value: escapeHtml(functionText), scroll: true, wide: true },
      { label: "Disease association", value: escapeHtml(diseaseText), wide: true },
      { label: "Referenced papers", value: refsHtml, scroll: true, wide: true }
    ]);
    renderLearnLinks(gene, accession, geneId);
    setProgress(5);
    setStatus("Loaded successfully.");
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
  viewer.addStyle(sel, { stick: { color: "#ff4d4d", radius: 0.35 } });
  viewer.addStyle(sel, { cartoon: { color: "#ff4d4d", thickness: 0.6 } });
  viewer.render();
}

function highlightDomain(entry, fragment, sourceEl) {
  if (!viewer || !model) return;

  document.querySelectorAll(".domain-bar.active, .interpro-item.active").forEach(el => el.classList.remove("active"));

  const isSame = highlightedDomain
    && highlightedDomain.accession === entry.accession
    && highlightedDomain.start === fragment.start
    && highlightedDomain.end === fragment.end;

  applyColoring(); // clears any previous highlight overlay, reapplies base style

  if (isSame) {
    highlightedDomain = null;
    document.getElementById("residueBar").textContent = "Click any residue in the structure to inspect it.";
    return;
  }

  highlightedDomain = { accession: entry.accession, start: fragment.start, end: fragment.end };
  reapplyDomainHighlight();

  document.querySelectorAll(`[data-domain-key="${entry.accession}:${fragment.start}-${fragment.end}"]`)
    .forEach(el => el.classList.add("active"));

  document.getElementById("residueBar").innerHTML =
    `<strong>${escapeHtml(entry.name)}</strong> · ${escapeHtml(entry.accession)} · ` +
    `residues ${fragment.start}-${fragment.end} highlighted in red on the structure above · click again to clear`;

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