# Gene Structure Explorer

A single-file, browser-based tool for looking up any human gene and getting its
predicted 3D protein structure, genomic location, key annotation, and linked
literature — all in one view.

## What it does

Type in a gene symbol (e.g. `TP53`, `INS`, `HBB`, `CTCF`, `PLAGL2`) and the
app will:

1. Look up the reviewed UniProt entry for that gene (restricted to human).
2. Pull the AlphaFold DB structure prediction for the matching accession.
3. Render it in an interactive 3Dmol.js viewer.
4. Surface annotation: protein name, aliases, subcellular location,
   length/mass, secondary structure composition, function summary, and
   disease associations.
5. Look up the gene's chromosome, cytogenetic band, and coordinates, and
   render its position on a full human karyotype.
6. Pull the linked PubMed references from UniProt.
7. Link out to related resources for deeper reading.

## Features

- **Structure viewer** — drag to rotate, scroll to zoom, click any residue to
  see its identity, chain, and pLDDT confidence score.
- **Style controls** — cartoon, sphere (backbone), or stick rendering.
- **Color modes** — pLDDT confidence, secondary structure, chain, or
  N→C spectrum, each with its own legend.
- **Auto-rotate** toggle and manual zoom/reset controls.
- **Collapsible secondary structure panel** — click the label to expand a
  helix/sheet/coil breakdown with percentage bars and residue counts.
- **Genomic location panel** — full human karyotype (Ideogram.js) with the
  searched gene's chromosome highlighted in red; click the highlight to open
  the gene's NCBI record.
- **Download** the raw PDB file or a PNG snapshot of the current view.
- **Read more** — quick links to UniProt, AlphaFold DB, NCBI Gene, GeneCards,
  RCSB PDB, PubMed, Ensembl, and STRING for the searched gene.

## Data sources

| Source | Used for |
| --- | --- |
| [UniProt REST API](https://www.uniprot.org/help/api) | Protein identity, function, disease, subcellular location, references |
| [AlphaFold DB API](https://alphafold.ebi.ac.uk/api-docs) | Predicted structure (PDB file) |
| [NCBI E-utilities](https://www.ncbi.nlm.nih.gov/books/NBK25501/) | Chromosome, cytogenetic band, and genomic coordinates |
| [3Dmol.js](https://3dmol.csb.pitt.edu/) | In-browser structure rendering |
| [Ideogram.js](https://eweitz.github.io/ideogram/) | In-browser chromosome/karyotype rendering |

All lookups are restricted to human (`organism_id:9606`), reviewed
(Swiss-Prot) UniProt entries only.

## Files

- `index.html` — the entire app (HTML, CSS, and JS in one file). Just open it
  in a browser; no build step or server required.

## Known limitations

- Only genes with a reviewed human UniProt entry and an existing AlphaFold
  prediction will resolve.
- Secondary structure percentages are computed from the AlphaFold model's own
  per-residue `ss` assignment, not an independent DSSP run.
- Reference list is capped at the first 12 entries UniProt returns.
- The genomic location panel requires the gene to have an NCBI GeneID
  cross-reference in UniProt; a small number of entries lack one.

## Ideas for later

- Cache recent gene lookups client-side to cut down repeat API calls.
- Add a sequence view alongside the 3D structure.
- Surface known structural domains/motifs (e.g. from InterPro) as selectable
  highlights on the model.
