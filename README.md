# Gene Structure Explorer

A browser-based tool for exploring human genes through UniProt, AlphaFold DB, NCBI Gene, 3Dmol.js, and Ideogram.js.

## Run locally

No build step is required.

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

Opening `index.html` directly may work in some browsers, but a local HTTP server is recommended because the app uses ES modules and remote APIs.

## Files

- `index.html` - page structure and controls.
- `styles.css` - presentation/styles.
- `app.js` - API access, caching, rendering, retries, and UI behavior.
- `test.html` - lightweight manual/browser checks.

## Reliability improvements

### Client-side caching
Gene lookups are cached in both an in-memory `Map` and `localStorage` for 24 hours. The cache is keyed by normalized gene symbol. If browser storage quota is exceeded, the app continues with the in-memory cache.

### Request lockout and stale-request protection
The Search button and gene input are disabled while a lookup is running. A new request also aborts the previous `fetch` chain. A request ID prevents late results from an older search from overwriting a newer result.

### Independent async stages
UniProt/AlphaFold are required for the main result. References and genomic location are separate stages, so a failure in one does not discard a successfully loaded structure.

### Retry/backoff
Transient network errors, HTTP 429 responses, and HTTP 5xx responses are retried up to three times with exponential backoff. `Retry-After` is respected when supplied.

### Accessibility
- Search and control elements use real event listeners instead of inline `onclick`/`onchange`.
- Zoom buttons have accessible labels.
- Keyboard activation is supported for the secondary-structure disclosure.
- Residue information is exposed through a live region.
- The Ideogram annotation gets keyboard access when the library renders the annotation element.

## Data sources

- UniProt REST API - protein identity, annotation, disease, subcellular location, and references.
- AlphaFold DB - predicted protein structure.
- NCBI E-utilities - genomic location.
- 3Dmol.js - structure visualization.
- Ideogram.js - chromosome visualization.

All gene searches are restricted to human reviewed (Swiss-Prot) UniProt entries.

## Cache

The current cache lifetime is 24 hours. Cached entries use the key prefix `gene-explorer:v2:`. To clear them from the browser console:

```js
Object.keys(localStorage)
  .filter(key => key.startsWith("gene-explorer:v2:"))
  .forEach(key => localStorage.removeItem(key));
```

## Known limitations

- Only genes with a reviewed human UniProt entry and an AlphaFold prediction can display a structure.
- Secondary-structure percentages come from the AlphaFold model's per-residue assignment.
- The reference list is capped at 12 UniProt references.
- The genomic panel requires a GeneID cross-reference.
- External API availability and browser CORS/network conditions can still affect results.
