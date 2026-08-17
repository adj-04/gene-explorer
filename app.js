const CACHE_PREFIX = "gene-explorer:v2:";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 600;

let viewer = null;
let model = null;
let spinning = false;
let currentPdbData = "";
let currentGeneName = "";
let currentAccession = "";
let currentGeneId = "-";
let lastSS = null;
let currentIdeogram = null;
let activeRequest = 0;
let requestController = null;
const memoryCache = new Map();

const $ = (id) => document.getElementById(id);

window.addEventListener("DOMContentLoaded", init);

function init() {
  bindEvents();
  try {
    $("emptyState")?.remove();
    viewer = $3Dmol.createViewer("viewer", { backgroundColor: 0x000000 });
    viewer.render();
    attachGentleZoom($("viewer"), () => viewer);
  } catch (error) {
    console.error(error);
    setStatus(`Viewer failed to initialize: ${error.message}`, true);
    return;
  }
}

function bindEvents() {
  $("searchButton").addEventListener("click", loadGene);
  $("geneInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") loadGene();
  });
  $("styleSelect").addEventListener("change", applyColoring);
  $("colorSelect").addEventListener("change", applyColoring);
  $("spinToggle").addEventListener("change", toggleSpin);
  $("resetButton").addEventListener("click", resetView);
  $("zoomInButton").addEventListener("click", zoomIn);
  $("zoomOutButton").addEventListener("click", zoomOut);
  $("downloadPdbButton").addEventListener("click", downloadPDB);
  $("downloadPngButton").addEventListener("click", downloadPNG);
}

function attachGentleZoom(element, getViewer) {
  element.addEventListener("wheel", (event) => {
    const activeViewer = getViewer();
    if (!activeViewer) return;
    event.preventDefault();
    event.stopPropagation();
    activeViewer.zoom(event.deltaY > 0 ? 0.97 : 1.03, 0);
    activeViewer.render();
  }, { passive: false, capture: true });
}

async function fetchJson(url, { signal, label = "request" } = {}) {
  return fetchWithRetry(url, {
    signal,
    label,
    parse: async (response) => response.json()
  });
}

async function fetchText(url, { signal, label = "request" } = {}) {
  return fetchWithRetry(url, {
    signal,
    label,
    parse: async (response) => response.text()
  });
}

async function fetchWithRetry(url, { signal, label, parse, retries = MAX_RETRIES } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
    try {
      const response = await fetch(url, { signal });
      if (response.ok) return await parse(response);

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === retries) {
        throw new Error(`${label} failed (HTTP ${response.status}).`);
      }

      const retryAfter = Number(response.headers.get("Retry-After"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : RETRY_BASE_MS * (2 ** attempt) + Math.random() * 250;
      await sleep(delay, signal);
    } catch (error) {
      if (error.name === "AbortError") throw error;
      lastError = error;
      if (attempt === retries) break;
      await sleep(RETRY_BASE_MS * (2 ** attempt) + Math.random() * 250, signal);
    }
  }
  throw lastError || new Error(`${label} failed.`);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Request cancelled", "AbortError"));
    }, { once: true });
  });
}

function cacheKey(gene) {
  return `${CACHE_PREFIX}${gene}`;
}

function getCachedGene(gene) {
  if (memoryCache.has(gene)) {
    const entry = memoryCache.get(gene);
    if (entry.expiresAt > Date.now()) return entry.data;
    memoryCache.delete(gene);
  }

  try {
    const raw = localStorage.getItem(cacheKey(gene));
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry?.data || entry.expiresAt <= Date.now()) {
      localStorage.removeItem(cacheKey(gene));
      return null;
    }
    memoryCache.set(gene, entry);
    return entry.data;
  } catch (error) {
    console.warn("Cache read failed:", error);
    return null;
  }
}

function setCachedGene(gene, data) {
  const entry = { cachedAt: Date.now(), expiresAt: Date.now() + CACHE_TTL_MS, data };
  memoryCache.set(gene, entry);
  try {
    localStorage.setItem(cacheKey(gene), JSON.stringify(entry));
  } catch (error) {
    // PDB files can be large enough to hit browser storage quotas.
    console.warn("Persistent cache unavailable; keeping this result in memory only.", error);
  }
}

function clearCurrentResults() {
  $("info").innerHTML = "";
  $("residueBar").textContent = "Click any residue in the structure to inspect it.";
  hideLocation();
  $("learnGrid").innerHTML = "";
  $("learnEmpty").style.display = "block";
  currentPdbData = "";
  currentAccession = "";
  currentGeneId = "-";
  lastSS = null;
  model = null;
  if (viewer) {
    viewer.clear();
    viewer.render();
  }
}

function setLoading(loading) {
  $("searchButton").disabled = loading;
  $("geneInput").disabled = loading;
  $("searchButton").textContent = loading ? "Loading…" : "Search";
}

function setStatus(message, isError = false, isSuccess = false) {
  const status = $("status");
  status.textContent = message || "";
  status.className = `status${isError ? " err" : ""}${isSuccess ? " success" : ""}`;
}

function isCurrent(requestId) {
  return requestId === activeRequest;
}

async function loadGene() {
  if (!viewer) {
    setStatus("Viewer not ready yet, try again in a second.", true);
    return;
  }
  if ($("searchButton").disabled) return;

  const gene = $("geneInput").value.trim().toUpperCase();
  if (!gene) {
    setStatus("Enter a gene symbol first.", true);
    $("geneInput").focus();
    return;
  }

  if (requestController) requestController.abort();
  requestController = new AbortController();
  const signal = requestController.signal;
  const requestId = ++activeRequest;

  currentGeneName = gene;
  clearCurrentResults();
  setLoading(true);
  setStatus(`Searching ${gene}…`);

  try {
    let data = getCachedGene(gene);
    const fromCache = Boolean(data);

    if (!data) {
      const protein = await fetchUniprotAccession(gene, signal);
      if (!isCurrent(requestId)) return;
      if (!protein) {
        setStatus(`No reviewed human UniProt entry found for ${gene}.`, true);
        return;
      }

      const accession = protein.primaryAccession;
      setStatus(`Loading AlphaFold structure for ${accession}…`);
      const pdbData = await fetchAlphaFoldStructure(accession, signal);
      if (!isCurrent(requestId)) return;

      data = {
        protein,
        accession,
        pdbData,
        geneId: "-",
        refsHtml: "No linked publications found.",
        location: null
      };

      // Independent stages: failure of references/location must not discard the usable structure.
      setStatus("Loading annotations…");
      try {
        const fullData = await fetchUniprotFull(accession, signal);
        data.geneId = getGeneId(fullData);
        data.refsHtml = renderReferences(fullData);
      } catch (error) {
        if (error.name === "AbortError") throw error;
        console.warn("Reference/GeneID stage failed:", error);
        data.annotationError = "References could not be loaded.";
      }

      if (data.geneId !== "-") {
        try {
          setStatus("Loading genomic location…");
          data.location = await fetchGenomicLocation(data.geneId, signal);
        } catch (error) {
          if (error.name === "AbortError") throw error;
          console.warn("Genomic location stage failed:", error);
          data.locationError = "Genomic location could not be loaded.";
        }
      }

      setCachedGene(gene, data);
    }

    if (!isCurrent(requestId)) return;
    renderGene(data, gene);

    const warnings = [];
    if (data.annotationError) warnings.push(data.annotationError);
    if (data.locationError) warnings.push(data.locationError);
    if (!data.location && data.geneId !== "-") warnings.push("Genomic location unavailable.");
    setStatus(
      fromCache
        ? `Loaded ${gene} from local cache${warnings.length ? ` · ${warnings.join(" ")}` : ""}`
        : warnings.length
          ? `Loaded ${gene} with warnings: ${warnings.join(" ")}`
          : `Loaded ${gene}.`,
      false,
      true
    );
  } catch (error) {
    if (error.name === "AbortError" || !isCurrent(requestId)) return;
    console.error(error);
    setStatus(error.message || "Something went wrong while loading this gene.", true);
  } finally {
    if (isCurrent(requestId)) {
      setLoading(false);
      requestController = null;
    }
  }
}

async function fetchUniprotAccession(gene, signal) {
  const query = encodeURIComponent(`gene:${gene} AND reviewed:true AND organism_id:9606`);
  const url = `https://rest.uniprot.org/uniprotkb/search?query=${query}&fields=accession,protein_name,organism_name,length,mass,cc_function,cc_disease,gene_names,cc_subcellular_location&format=json&size=1`;
  const data = await fetchJson(url, { signal, label: "UniProt search" });
  return data.results?.[0] || null;
}

async function fetchAlphaFoldStructure(accession, signal) {
  const metaData = await fetchJson(`https://alphafold.ebi.ac.uk/api/prediction/${encodeURIComponent(accession)}`, {
    signal, label: "AlphaFold metadata"
  });
  if (!Array.isArray(metaData) || !metaData.length || !metaData[0].pdbUrl) {
    throw new Error(`No AlphaFold structure available for ${accession}.`);
  }
  const pdbData = await fetchText(metaData[0].pdbUrl, { signal, label: "AlphaFold structure" });
  if (!pdbData.trim()) throw new Error(`AlphaFold returned an empty structure for ${accession}.`);
  return pdbData;
}

async function fetchUniprotFull(accession, signal) {
  return fetchJson(`https://rest.uniprot.org/uniprotkb/${encodeURIComponent(accession)}.json`, {
    signal, label: "UniProt annotations"
  });
}

async function fetchGenomicLocation(geneId, signal) {
  if (!geneId || geneId === "-") return null;
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=gene&id=${encodeURIComponent(geneId)}&retmode=json`;
  const data = await fetchJson(url, { signal, label: "NCBI genomic location" });
  const doc = data.result?.[geneId];
  if (!doc) return null;

  const gi = (doc.genomicinfo || [])[0];
  const chr = doc.chromosome || gi?.chrloc;
  if (!chr || !gi) return null;

  const a = parseInt(gi.chrstart, 10);
  const b = parseInt(gi.chrstop, 10);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;

  return {
    chr: String(chr),
    mapLocation: doc.maplocation || "",
    start: Math.min(a, b),
    stop: Math.max(a, b)
  };
}

function renderGene(data, gene) {
  const protein = data.protein;
  const accession = data.accession;
  currentAccession = accession;
  currentGeneId = data.geneId || "-";
  currentPdbData = data.pdbData;

  const proteinName = protein.proteinDescription?.recommendedName?.fullName?.value || "Unknown";
  const length = protein.sequence?.length || 0;
  const mass = protein.sequence?.molWeight
    ? `${(protein.sequence.molWeight / 1000).toFixed(1)} kDa`
    : "-";
  const functionText = cleanText(
    protein.comments?.find(c => c.commentType === "FUNCTION")?.texts?.[0]?.value
  ) || "No function summary available.";
  const diseaseText = cleanText(
    protein.comments?.find(c => c.commentType === "DISEASE")?.disease?.description
  ) || "No disease association listed.";
  const synonyms = (protein.genes?.[0]?.synonyms || []).map(s => s.value);
  const aliases = synonyms.length ? synonyms.join(", ") : "No known aliases listed.";
  const subcellLocs = (protein.comments?.find(c => c.commentType === "SUBCELLULAR_LOCATION")?.subcellularLocations || [])
    .map(l => l.location?.value).filter(Boolean);
  const subcellText = subcellLocs.length ? subcellLocs.join(", ") : "Not annotated.";

  viewer.clear();
  model = viewer.addModel(data.pdbData, "pdb");
  applyColoring();
  viewer.zoomTo();
  viewer.render();

  viewer.setClickable({}, true, (atom) => {
    if (!atom) return;
    const confidence = atom.b != null ? atom.b.toFixed(1) : "-";
    $("residueBar").innerHTML =
      `<strong>${escapeHtml(atom.resn || "Residue")} ${escapeHtml(String(atom.resi ?? ""))}</strong>` +
      ` · chain ${escapeHtml(atom.chain || "-")} · confidence (pLDDT): ${escapeHtml(confidence)}`;
    $("residueBar").focus({ preventScroll: true });
  });

  lastSS = computeSecondaryStructureStats();

  renderInfo([
    { label: "Gene", value: `${escapeHtml(gene)} · ${escapeHtml(accession)}`, mono: true },
    { label: "NCBI Gene ID", value: escapeHtml(currentGeneId), mono: true },
    { label: "Protein", value: escapeHtml(proteinName) },
    { label: "Aliases", value: escapeHtml(aliases) },
    { label: "Subcellular location", value: escapeHtml(subcellText) },
    { label: "Length / mass", value: `${length} aa · ${escapeHtml(mass)}`, mono: true },
    {
      label: "Secondary structure",
      value: lastSS
        ? `${lastSS.helix}% helix · ${lastSS.sheet}% sheet · ${lastSS.coil}% coil · click to expand`
        : "-",
      mono: true, collapsible: true, id: "ssField", detail: ssDetailHtml(lastSS)
    },
    { label: "Function", value: escapeHtml(functionText), scroll: true, wide: true },
    { label: "Disease association", value: escapeHtml(diseaseText), wide: true },
    { label: "Referenced papers", value: data.refsHtml || "No linked publications found.", scroll: true, wide: true }
  ]);

  renderLearnLinks(gene, accession, currentGeneId);
  renderIdeogram(data.location, gene, currentGeneId);
}

function renderInfo(fields) {
  $("info").innerHTML = fields.map((field) => `
    <div class="field${field.wide ? " wide" : ""}${field.collapsible ? " collapsible" : ""}" ${field.collapsible ? `id="${field.id}"` : ""}>
      <div class="field-label" ${field.collapsible ? `role="button" tabindex="0" aria-expanded="false" data-toggle="${field.id}"` : ""}>
        ${field.label}${field.collapsible ? '<span class="caret">&#9656;</span>' : ""}
      </div>
      <div class="field-value${field.mono ? " mono" : ""}${field.scroll ? " scroll" : ""}">${field.value}</div>
      ${field.detail ? `<div class="ss-detail">${field.detail}</div>` : ""}
    </div>
  `).join("");

  $("info").querySelectorAll("[data-toggle]").forEach((control) => {
    const toggle = () => toggleCollapsible(control.dataset.toggle);
    control.addEventListener("click", toggle);
    control.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    });
  });
}

function toggleCollapsible(id) {
  const field = $(id);
  const control = field?.querySelector("[data-toggle]");
  if (!field || !control) return;
  const open = field.classList.toggle("open");
  control.setAttribute("aria-expanded", String(open));
}

function renderReferences(fullData) {
  const refs = (fullData.references || []).slice(0, 12).map((reference) => {
    const pmid = (reference.citationCrossReferences || []).find(x => x.database === "PubMed")?.id;
    const title = reference.citation?.title || "Untitled";
    const journal = reference.citation?.journal || "";
    const year = reference.citation?.publicationDate || "";
    const safeTitle = escapeHtml(title);
    const pubmedUrl = pmid ? `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(pmid)}/` : "";
    const titleHtml = pmid
      ? `<a class="ref-title-link" href="${pubmedUrl}" target="_blank" rel="noopener noreferrer">${safeTitle}</a>`
      : `<span class="ref-title-link" style="color:var(--text);">${safeTitle}</span>`;
    const linkLine = pmid
      ? `<a href="${pubmedUrl}" target="_blank" rel="noopener noreferrer">PMID:${escapeHtml(String(pmid))} →</a>`
      : "";
    return `<div class="ref-item">${titleHtml}<div class="ref-meta">${escapeHtml(`${journal} ${year}`.trim())}</div>${linkLine}</div>`;
  });
  return refs.length ? refs.join("") : "No linked publications found.";
}

function getGeneId(fullData) {
  return (fullData.uniProtKBCrossReferences || []).find(x => x.database === "GeneID")?.id || "-";
}

function renderIdeogram(location, geneSymbol, geneId) {
  const section = $("locationSection");
  const container = $("ideoContainer");
  const hint = $("ideoHint");
  container.innerHTML = "";
  hint.textContent = "";
  currentIdeogram = null;

  if (!location) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  $("ideoLocText").textContent =
    `Chromosome ${location.chr}${location.mapLocation ? ` · band ${location.mapLocation}` : ""} · ` +
    `chr${location.chr}:${location.start.toLocaleString()}-${location.stop.toLocaleString()}`;

  if (typeof Ideogram === "undefined") {
    hint.textContent = "Chromosome diagram library failed to load. The rest of the gene data is still available.";
    return;
  }

  const annotation = [{
    name: geneSymbol, chr: location.chr,
    start: location.start, stop: location.stop, color: "#ff4d4d"
  }];

  try {
    currentIdeogram = new Ideogram({
      container: "#ideoContainer",
      organism: "human",
      chrHeight: 300,
      rotatable: false,
      annotationsLayout: "overlay",
      annotationHeight: 6,
      annotations: annotation,
      onLoad: wireIdeogramClick
    });
    hint.textContent = geneId !== "-"
      ? `Red mark shows ${geneSymbol}'s position · click it to open the NCBI Gene page`
      : `Red mark shows ${geneSymbol}'s position on the chromosome`;
  } catch (error) {
    console.error("Ideogram render failed:", error);
    hint.textContent = `Couldn't render the chromosome diagram: ${error.message}`;
  }

  function wireIdeogramClick() {
    if (!geneId || geneId === "-") return;
    container.querySelectorAll('[class*="annot"]').forEach((element) => {
      element.style.cursor = "pointer";
      element.setAttribute("role", "link");
      element.setAttribute("tabindex", "0");
      element.setAttribute("aria-label", `Open NCBI Gene page for ${geneSymbol}`);
      const open = () => window.open(
        `https://www.ncbi.nlm.nih.gov/gene/${encodeURIComponent(geneId)}`,
        "_blank", "noopener,noreferrer"
      );
      element.addEventListener("click", open);
      element.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
    });
  }
}

function hideLocation() {
  $("locationSection").hidden = true;
  $("ideoContainer").innerHTML = "";
  $("ideoLocText").textContent = "";
  $("ideoHint").textContent = "";
  currentIdeogram = null;
}

function renderLearnLinks(gene, accession, geneId) {
  const encodedGene = encodeURIComponent(gene);
  const links = [
    { name:"UniProt", url:`https://www.uniprot.org/uniprotkb/${encodeURIComponent(accession)}/entry`, desc:"Full curated protein record" },
    { name:"AlphaFold DB", url:`https://alphafold.ebi.ac.uk/entry/${encodeURIComponent(accession)}`, desc:"Source page for this structure" },
    { name:"GeneCards", url:`https://www.genecards.org/cgi-bin/carddisp.pl?gene=${encodedGene}`, desc:"Aggregated gene summary" },
    { name:"RCSB PDB", url:`https://www.rcsb.org/search?q=${encodedGene}`, desc:"Experimentally solved structures, if any" },
    { name:"PubMed", url:`https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(gene + " Homo sapiens")}`, desc:"Full literature search" },
    { name:"Ensembl", url:`https://www.ensembl.org/Homo_sapiens/Gene/Summary?g=${encodedGene}`, desc:"Genomic context, transcripts, variants" },
    { name:"STRING", url:`https://string-db.org/network/${encodedGene}`, desc:"Protein-protein interaction network" }
  ];
  if (geneId !== "-") {
    links.splice(2, 0, {
      name:"NCBI Gene", url:`https://www.ncbi.nlm.nih.gov/gene/${encodeURIComponent(geneId)}`,
      desc:"Genomic location, aliases, expression"
    });
  }

  $("learnEmpty").style.display = "none";
  $("learnGrid").innerHTML = links.map(link => `
    <a class="learn-card" href="${link.url}" target="_blank" rel="noopener noreferrer">
      <div class="learn-name">${escapeHtml(link.name)}</div>
      <div class="learn-desc">${escapeHtml(link.desc)}</div>
    </a>
  `).join("");
}

function computeSecondaryStructureStats() {
  if (!model) return null;
  const atoms = model.selectedAtoms({ atom: "CA" });
  if (!atoms.length) return null;
  let helix = 0, sheet = 0, coil = 0;
  atoms.forEach(atom => {
    if (atom.ss === "h") helix++;
    else if (atom.ss === "s") sheet++;
    else coil++;
  });
  const total = atoms.length;
  return {
    helix: ((helix / total) * 100).toFixed(0),
    sheet: ((sheet / total) * 100).toFixed(0),
    coil: ((coil / total) * 100).toFixed(0),
    helixCount: helix, sheetCount: sheet, coilCount: coil, total
  };
}

function ssDetailHtml(ss) {
  if (!ss) return "";
  const row = (label, color, pct, count) => `
    <div>${label} · ${pct}% (${count} residues)</div>
    <div class="ss-bar-row">
      <div class="ss-bar-track"><div class="ss-bar-fill" style="width:${pct}%;background:${color}"></div></div>
    </div>`;
  return `${row("Helix","#e8a94a",ss.helix,ss.helixCount)}
    ${row("Sheet","#5eaefc",ss.sheet,ss.sheetCount)}
    ${row("Coil","#85837a",ss.coil,ss.coilCount)}
    <div style="margin-top:.5rem;">Total residues modeled: ${ss.total}</div>`;
}

function applyColoring() {
  if (!viewer || !model) return;
  const colorMode = $("colorSelect").value;
  const styleMode = $("styleSelect").value;
  viewer.setStyle({}, {});

  let colorSpec;
  if (colorMode === "confidence") colorSpec = { colorfunc: atom => plddtColor(atom.b) };
  else if (colorMode === "chain") colorSpec = { color: "chain" };
  else if (colorMode === "secondary") colorSpec = { color: "ssPyMOL" };
  else colorSpec = { color: "spectrum" };

  if (styleMode === "sphere") {
    viewer.setStyle({ atom:"CA" }, { sphere:{ ...colorSpec, radius:1.1 } });
  } else {
    const styleObject = {};
    styleObject[styleMode] = colorSpec;
    viewer.setStyle({}, styleObject);
  }

  $("legend-confidence").style.display = colorMode === "confidence" ? "flex" : "none";
  $("legend-spectrum").style.display = colorMode === "spectrum" ? "flex" : "none";
  $("legend-secondary").style.display = colorMode === "secondary" ? "flex" : "none";
  viewer.render();
}

function toggleSpin() {
  spinning = $("spinToggle").checked;
  if (viewer) viewer.spin(spinning ? "y" : false);
}
function resetView() { if (viewer && model) { viewer.zoomTo(); viewer.render(); } }
function zoomIn() { if (viewer && model) { viewer.zoom(1.2, 200); viewer.render(); } }
function zoomOut() { if (viewer && model) { viewer.zoom(0.8, 200); viewer.render(); } }

function plddtColor(value) {
  if (value > 90) return "#0053D6";
  if (value > 70) return "#65CBF3";
  if (value > 50) return "#FFDB13";
  return "#FF7D45";
}

function downloadPDB() {
  if (!currentPdbData) {
    setStatus("No structure is loaded.", true);
    return;
  }
  downloadBlob(new Blob([currentPdbData], { type:"chemical/x-pdb" }), `${currentGeneName || "structure"}.pdb`);
}

function downloadPNG() {
  if (!viewer || !model) {
    setStatus("No structure is loaded.", true);
    return;
  }
  const uri = viewer.pngURI();
  const anchor = document.createElement("a");
  anchor.href = uri;
  anchor.download = `${currentGeneName || "structure"}.png`;
  anchor.click();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function cleanText(text) {
  if (!text) return "";
  return text.replace(/\(PubMed:\d+(,\s*PubMed:\d+)*\)/gi, "")
    .replace(/\[PubMed:\d+\]/gi, "")
    .replace(/\s{2,}/g, " ").trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
    .replaceAll('"',"&quot;").replaceAll("'","&#039;");
}
