# CheXboard

Interactive leaderboard for **“Benchmarking Classification Tasks of Chest X-ray AI
Across Multinational Public and Private Datasets”**
([arXiv:2505.16027](https://arxiv.org/abs/2505.16027)). Ten published chest-radiograph classifiers, run
unmodified across twelve cohorts in four world regions, compared per finding with
95% confidence intervals.

**Live site:** https://gevaertlab.github.io/chexboard-cxr-leaderboard/

![The CheXboard leaderboard: ten chest X-ray models ranked by mean AUROC with
95% confidence intervals, beside filters for metric, population, model,
region and cohort.](site/assets/screenshot.png)

Filter by model, region, cohort, finding, task category and age band; switch the
metric (AUROC, AUPRC, Sens@95Spec, Spec@95Sens, PPV/NPV@95Sens, Youden
sensitivity/specificity); and read the result as a ranked table or as ranking,
heatmap, model-versus-model, or per-category charts. Every view is encoded in the
URL hash, so any filtered state can be bookmarked or cited. The table exports to
CSV.

The site is **fully static and self-contained** — no build step, no server, no
external requests. Plotly is vendored, so it also runs from a local folder or an
air-gapped machine.

## Repository layout

```
chexboard-cxr-leaderboard/
├── site/                      # ← exactly what GitHub Pages serves
│   ├── index.html
│   ├── app.js                 # state, filtering, aggregation, table, URL state
│   ├── charts.js              # Plotly builders (ranking / heatmap / compare / breakdown)
│   ├── style.css
│   ├── 404.html  robots.txt  sitemap.xml  .nojekyll
│   ├── favicon.svg  favicon.png  apple-touch-icon.png
│   ├── assets/                # Stanford Medicine logo, social card, screenshot
│   ├── vendor/plotly.min.js   # vendored → works offline
│   └── data/
│       ├── leaderboard.json   # the facts: one record per model × cohort × finding × metric × stratum
│       └── meta.json          # display metadata + provenance stamp
├── tools/build_data.py        # how data/*.json is produced
└── .github/workflows/deploy.yml
```

## Where the numbers come from

Nothing in this repository computes a metric. `site/data/*.json` is a **pure
derivative** of one summary table produced by the analysis pipeline that
accompanies the manuscript:

```
summary_long.parquet   (analysis pipeline — the source of truth)
        │
        │   tools/build_data.py      (the only bridge)
        ▼
site/data/{leaderboard,meta}.json
        │
        ▼
the static site           (never reads anything else)
```

Each build stamps a **provenance block** — source path, byte size, mtime, sha1,
pipeline git revision, build timestamp, row count — into both JSON files. It is
shown under *About & methods → Reproducibility* on the site, so any number on the
page can be traced back to an exact upstream state. `build_data.py` is included
here for transparency; it imports the analysis pipeline's own modules and cannot
be run standalone from this repository.

The browser only does the pooling described on the site: within a metric and
stratum, cells are averaged **equal-weight per finding** by default (across
cohorts within a finding, then across findings), which is the aggregation the
manuscript's headline figures use. Confidence intervals on an aggregate are the
across-unit spread (mean ± 1.96·SE), falling back to the contributing cells'
own bootstrap intervals when a filter narrows the view to a single unit.

**No images or patient-level data are distributed here.** The five private cohorts
contributed derived evaluation metrics only.

## Running it locally

```bash
cd site && python -m http.server 8731
# open http://localhost:8731
```

A static server is required: opening `index.html` straight from disk makes the
browser block the `fetch()` of the JSON under `file://` rules. The page detects
this case and says so rather than showing a blank screen.

## Reporting an error

Spotted a number that looks wrong? Please
[open an issue](https://github.com/gevaertlab/chexboard-cxr-leaderboard/issues).

`site/` is generated — it is mirrored here from the analysis repository, and a
pull request against it would be overwritten by the next data refresh. Corrections
are made upstream in the pipeline and re-published, so an issue is the way to get
one fixed.

## Citing

Please cite the [arXiv preprint](https://arxiv.org/abs/2505.16027):

```bibtex
@misc{xu2025benchmarking,
  title         = {Benchmarking Classification Tasks of Chest X-ray {AI} Across Multinational
                   Public and Private Datasets: a retrospective diagnostic accuracy study},
  author        = {Xu, Qinmei and Li, Yiheng and Zhao, Wenya and Zhao, Zihao
                   and Xu, Chuanjun and Er, Ahmet Gorkem and Zhan, Xianghao
                   and Dashevsky, Brittany and Alawad, Mohammed and von der St{\"u}ck, Marc
                   and Gazibari{\'c}, Marvin and Truhn, Daniel and Shibata, Shunsuke
                   and Horino, Ryosuke and Ito, Mio and Hiwatashi, Akio and Li, Suyu
                   and Yang, Mengya and Liu, Ya and Sun, Zhiyuan and Zhou, Changsheng
                   and Itakura, Haruka and Li, Xiao and Gevaert, Olivier},
  year          = {2025},
  eprint        = {2505.16027},
  archivePrefix = {arXiv},
  primaryClass  = {eess.IV},
  doi           = {10.48550/arXiv.2505.16027},
  url           = {https://arxiv.org/abs/2505.16027}
}
```

Machine-readable metadata is in [`CITATION.cff`](CITATION.cff). The evaluation
code will be released with the article.

## License

Site and build code: **Apache-2.0** (see [`LICENSE`](LICENSE)).
Benchmark results in `site/data/`: **[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)**.

`site/vendor/plotly.min.js` is [Plotly.js](https://github.com/plotly/plotly.js),
MIT-licensed, © Plotly, Inc. Institutional logos in `site/assets/` are trademarks
of their owners and are not covered by either license.

Built and maintained by the [Gevaert Lab](https://med.stanford.edu/gevaertlab.html),
Stanford University School of Medicine.
