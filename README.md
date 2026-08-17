# Gene Structure Explorer

A browser-based tool for looking up any human gene and getting its predicted 3D
protein structure, domain architecture, genomic location, annotation, and linked
literature — all in one view.

Built because inspecting a single gene meant switching between UniProt,
AlphaFold, InterPro, and NCBI every time.

## What it does

Type in a gene symbol (e.g. `TP53`, `SHH`, `INS`, `HBB`, `PLAGL2`) and the app will:

1. Look up the reviewed human UniProt entry for that gene.
2. Fetch the AlphaFold DB structure prediction for the matching accession and
   render it in an interactive 3Dmol.js viewer.
3. Fetch InterPro's precomputed domain/family/site matches and draw them on a
   sequence-coordinate map.
4. Look up the gene's chromosome, cytogenetic band, and coordinates, and mark its
   position on a human karyotype.
5. Surface annotation: protein name, aliases, subcellular location, length/mass,
   secondary structure composition, function summary, disease associations.
6. Pull linked PubMed references and related database links.

## Features

**Structure viewer**
- Drag to rotate, scroll to zoom, click any residue for its identity, chain, and
  pLDDT confidence score.
- Style modes: cartoon, sphere (backbone), stick.
- Color modes: pLDDT confidence, secondary structure, chain, N→C spectrum — each
  with its own legend.
- Auto-rotate toggle, manual zoom, reset view.
- Download the raw PDB file or a PNG snapshot of the current view.

**Domains & features**
- Sequence-coordinate map showing every located InterPro entry, colored by type
  (domain / family / superfamily / repeat / site).
- **Click a domain bar or card to highlight those residues in red on the 3D
  structure.** The highlight recolors within your current style mode and survives
  style/color changes. Click again to clear.
- Entries spanning >80% of the protein are flagged as such, so a mostly-red
  structure reads as a whole-protein family classification rather than a bug.
- Ctrl/cmd-click a bar to open its curated InterPro entry instead.

**Genomic location**
- Full human karyotype with the gene's chromosome marked in red.
- Chromosome, cytogenetic band, and base-pair range shown above the diagram.
- Click the marker to open the gene's NCBI record.

**Other**
- Collapsible secondary structure panel with helix/sheet/coil percentages and
  residue counts.
- Five-stage progress indicator during load.
- Read more: quick links to UniProt, AlphaFold DB, NCBI Gene, GeneCards, RCSB
  PDB, PubMed, Ensembl, InterPro, and STRING for the searched gene.

## Data sources

| Source | Used for |
| --- | --- |
| [UniProt REST API](https://www.uniprot.org/help/api) | Protein identity, function, disease, subcellular location, references |
| [AlphaFold DB API](https://alphafold.ebi.ac.uk/api-docs) | Predicted structure (PDB file) |
| [InterPro API](https://www.ebi.ac.uk/interpro/) | Precomputed protein family, domain, and site matches |
| [NCBI E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25501/) | Chromosome, cytogenetic band, genomic coordinates |
| [3Dmol.js](https://3dmol.csb.pitt.edu/) | In-browser structure rendering |
| [Ideogram.js](https://eweitz.github.io/ideogram/) | In-browser karyotype rendering |

All lookups are restricted to human (`organism_id:9606`), reviewed (Swiss-Prot)
UniProt entries. InterPro matches are read from precomputed results — no
InterProScan run is performed.

## Running it

No build step, no backend. Either open `index.html` directly in a browser, or
serve the folder:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Files

- `index.html` — markup
- `styles.css` — styling
- `app.js` — all application logic
- `eslint.config.js` — lint config

## Development

Run the linter before pushing:

```bash
npm install --save-dev eslint
npx eslint app.js
```

`no-undef` is set to error — `app.js` runs under `"use strict"` as a plain
script, so an undeclared variable is a runtime crash, not a silent global.

## Implementation notes

- Requests use `AbortController` plus a request-sequence check, so a rapid second
  search can't be overwritten by a slow first one.
- Failed requests retry with exponential backoff, honoring `Retry-After`.
- Responses are cached in `localStorage` with a 24-hour TTL.
- Enrichment steps (references, InterPro, genomic location) fail independently —
  one API being down doesn't take out the rest of the result.
- `app.js` is loaded as a plain `<script defer>`, not `type="module"`. Module
  scripts are blocked over `file://`, which would break opening the page locally.

## Known limitations

- Only genes with a reviewed human UniProt entry and an existing AlphaFold
  prediction will resolve.
- Secondary structure percentages come from the AlphaFold model's own per-residue
  assignment, not an independent DSSP run.
- Reference list is capped at the first 12 entries UniProt returns.
- Genomic location requires an NCBI GeneID cross-reference in UniProt; a few
  entries lack one.
- The karyotype is not zoomable — the band and coordinate readout above it carries
  the precise location instead.
