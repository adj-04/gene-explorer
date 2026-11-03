# Gene Structure Explorer

A browser-based tool for looking up any human gene and getting its predicted 3D
protein structure, domain architecture, disease variants, coding sequence,
genomic location, expression, interaction partners, annotation, and linked
literature — all in one view.

Built because inspecting a single gene meant switching between UniProt,
AlphaFold, InterPro, ClinVar, Ensembl, GTEx, STRING, and NCBI every time.

## What it does

Type in a gene symbol (e.g. `TP53`, `SHH`, `INS`, `HBB`, `PLAGL2`) and the app will:

1. Look up the reviewed human UniProt entry for that gene.
2. Fetch the AlphaFold DB structure prediction for the matching accession and
   render it in an interactive 3Dmol.js viewer.
3. Fetch InterPro's precomputed domain/family/site matches and draw them on a
   sequence-coordinate map.
4. Look up the gene's chromosome, cytogenetic band, coordinates, and NCBI gene
   summary, and mark its position on a human karyotype.
5. Surface annotation: protein name, aliases, subcellular location, length/mass,
   secondary structure composition, gene summary, function, disease associations.
6. Pull linked PubMed references and related database links.
7. In the background, load pathogenic / disease-associated variants, top
   interaction partners, tissue expression, and the gene's real coding sequence.

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
- **Click a domain bar or card to focus it on the 3D structure:** the selected
  residues keep their colors, the rest of the protein turns grey, and the camera
  zooms onto the region. Works in every style/color mode and survives
  style/color changes. Click again to clear and zoom back out.
- Entries spanning >80% of the protein are flagged as such, so a mostly-colored
  structure reads as a whole-protein family classification rather than a bug.
- Ctrl/cmd-click a bar to open its curated InterPro entry instead.

**Disease variants**
- Pathogenic, likely pathogenic, and disease-associated variants from UniProt and
  ClinVar (via the EBI Proteins API), marked as ticks along the protein.
- Cards show the change (e.g. `R138Q`), clinical significance, linked disease,
  and dbSNP rsID. The first six are shown, with **See more** to expand.
- Click a tick or card to focus that residue on the structure — side chain shown,
  camera zoomed in.

**Interaction partners**
- Top functional partners from STRING with their combined confidence score.
- Each partner opens its own Gene Structure Explorer page in a new tab.

**Tissue expression**
- Median expression (TPM) across GTEx tissues, top 10 shown as bars, with a link
  to the full GTEx profile.

**Genomic location**
- Full human karyotype with the gene's chromosome marked in red, scaled to fit
  the card with no scrollbars.
- Chromosome, cytogenetic band, and base-pair range shown above the diagram.
- Click the marker to open the gene's NCBI record.

**Coding-sequence helix** (left margin, wide screens)
- A B-DNA double helix drawn from the gene's real coding sequence (Ensembl
  transcript linked from the UniProt entry): one rung per base pair, colored by
  base, 10.5 bp per turn, with major and minor grooves.
- Screws along the CDS as you scroll — start codon at the top of the page, stop
  codon at the bottom. Highlighting a domain, variant, or residue glides it to
  that region's codons.
- Domains tint the backbone amber, variant codons are marked, the highlighted
  region glows red.
- Hover a base pair for its `c.` position, codon, and amino acid; click it to
  focus that residue on the structure.
- The CDS is translated and checked against the UniProt sequence; if they differ
  (a different isoform), the caption says so.

**Navigation**
- Section minimap in the right margin: dots sit at each section's real position
  and re-flow as content loads; a glowing window shows the visible part of the
  page and can be dragged like a scrollbar. Section names decode from a DNA
  strand as the cursor comes near. On smaller screens this becomes a floating
  section pill.
- Shareable links: the URL updates to `?gene=SYMBOL`, and opening such a link
  loads that gene directly.
- The last three searches are kept as one-click chips under the search box.

**Other**
- Collapsible secondary structure panel with helix/sheet/coil percentages and
  residue counts.
- Five-stage progress indicator during load.
- Read more: quick links to UniProt, AlphaFold DB, NCBI Gene, GeneCards, RCSB
  PDB, PubMed, Ensembl, InterPro, and STRING for the searched gene.
- Animations respect the system "reduce motion" setting.

## Data sources

| Source | Used for |
| --- | --- |
| [UniProt REST API](https://www.uniprot.org/help/api) | Protein identity, sequence, function, disease, subcellular location, references |
| [AlphaFold DB API](https://alphafold.ebi.ac.uk/api-docs) | Predicted structure (PDB file) |
| [InterPro API](https://www.ebi.ac.uk/interpro/) | Precomputed protein family, domain, and site matches |
| [EBI Proteins API](https://www.ebi.ac.uk/proteins/api/doc/) | Variants with UniProt and ClinVar clinical significance |
| [Ensembl REST API](https://rest.ensembl.org/) | Coding sequence (CDS) of the linked transcript |
| [NCBI E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25501/) | Gene summary, chromosome, cytogenetic band, genomic coordinates |
| [STRING API](https://string-db.org/help/api/) | Protein interaction partners |
| [GTEx Portal API](https://gtexportal.org/api/v2/redoc) | Median tissue expression (GTEx v8) |
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
script, so an undeclared variable is a runtime crash, not a silent global. Any
new browser API used in `app.js` needs adding to the `globals` list in
`eslint.config.js`.

## Implementation notes

- Requests use `AbortController` plus a request-sequence check, so a rapid second
  search can't be overwritten by a slow first one.
- Failed requests retry with exponential backoff, honoring `Retry-After`.
- Responses are cached in `localStorage` with a 24-hour TTL.
- Enrichment steps (references, InterPro, genomic location) fail independently —
  one API being down doesn't take out the rest of the result.
- Variants, partners, expression, and the coding sequence load in the background
  after the structure, each in its own section, so a slow API never delays the
  main result. A failure shows a note in that section only.
- The helix and minimap are progressive extras: hidden below 1340px wide, paused
  when the tab isn't visible, and nothing else depends on them.
- `app.js` is loaded as a plain `<script defer>`, not `type="module"`. Module
  scripts are blocked over `file://`, which would break opening the page locally.

## Known limitations

- Only genes with a reviewed human UniProt entry and an existing AlphaFold
  prediction will resolve.
- Residue highlighting assumes the structure's numbering matches UniProt, which
  holds for AlphaFold models.
- Secondary structure percentages come from the AlphaFold model's own per-residue
  assignment, not an independent DSSP run.
- Reference list is capped at the first 12 entries UniProt returns.
- Variant cards list the first 60 by position; every variant is still marked on
  the track.
- Genomic location requires an NCBI GeneID cross-reference in UniProt; a few
  entries lack one.
- GTEx expression is looked up by gene symbol; genes with no GTEx record show an
  empty section.
- The karyotype is not zoomable — the band and coordinate readout above it carries
  the precise location instead.
