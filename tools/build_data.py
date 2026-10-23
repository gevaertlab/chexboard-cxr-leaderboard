#!/usr/bin/env python
"""Build the static leaderboard data from the manuscript summary.

Reads ``00_Manuscript_Results_Generation/output/summary/summary_long.parquet`` and
emits two JSON files consumed by the static site (``site/data/``):

* ``leaderboard.json`` -- a compact, *columnar* long table (one record per
  ``model x dataset x pathology x metric x stratum``) already pooled
  (Nanjing Multi-Hospital), canonicalised (task names + anatomy/extent/prevalence
  category tags), public/private tagged and rounded. The site does all filtering
  and aggregation client-side from this.
* ``meta.json`` -- display/citation metadata: models (official name, type, color,
  citation, binary flag), datasets (official name, region, country, scope, N),
  metrics (label, description, direction, range) and the category-scheme
  definitions.

The build *reuses* the manuscript pipeline's own logic so the leaderboard matches
the paper exactly: region/country from ``config.py`` (source of truth), the
``merge_nanjing_mh`` pooling, the public/private split and official names from the
figures' ``_common.py``, and the task categorisation from
``fig7_task_categories/task_categories.py``.

Usage (chexray39 env):
    cd scripts/05_Leaderboard_Generation && python build_data.py
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
MANUSCRIPT = REPO_ROOT / "scripts" / "00_Manuscript_Results_Generation"
FIGURES = MANUSCRIPT / "figures"
SITE_DATA = HERE / "site" / "data"

# Import the manuscript pipeline's own modules (single source of truth).
sys.path.insert(0, str(MANUSCRIPT))
sys.path.insert(0, str(FIGURES))
sys.path.insert(0, str(FIGURES / "fig7_task_categories"))
import config as cfg                       # noqa: E402  (00/config.py)
import _common as common                   # noqa: E402  (figures/_common.py)
import task_categories as tc               # noqa: E402  (fig7 categorisation)

# Metrics exposed in the leaderboard. miss_rate is dropped (= 1 - sensitivity).
METRICS = [
    "auroc", "auprc", "sens_at_95spec", "spec_at_95sens",
    "ppv_at_95sens", "npv_at_95sens", "sensitivity", "specificity",
]

# (dimension, group) -> stratum tag exposed to the UI. The paper de-emphasizes the
# binary adult/pediatric split, so the leaderboard surfaces coarse age bands instead
# (data-driven, only where per-image ages exist; cohorts without ages show no band
# rows). The ped_adult rows still exist in the summary but are not exposed here.
STRATA = {
    ("Overall", "All"): "overall",
    ("age_band", "<18"): "<18",
    ("age_band", "18-65"): "18-65",
    ("age_band", "65+"): "65+",
}
# Human labels + order for the strata above (used in meta.json).
STRATUM_LABEL = {"overall": "Overall", "<18": "Age <18", "18-65": "Age 18–65", "65+": "Age 65+"}

# --- curated model metadata -------------------------------------------------
# type: how the model produces a label (for grouping / honest framing).
#   VLM  = contrastive vision-language zero/▸prompt classifier
#   CNN  = supervised convolutional classifier
#   GEN  = generative report/VQA model (binary output only)
#   GEN+ = generative features + tabular booster (probabilistic)
MODEL_META = {
    "MAVL":                {"official": "MAVL",        "type": "VLM",  "citation": "Phan et al., CVPR 2024"},
    "MedKLIP":             {"official": "MedKLIP",     "type": "VLM",  "citation": "Wu et al., ICCV 2023"},
    "CheXzero":            {"official": "CheXzero",    "type": "VLM",  "citation": "Tiu et al., Nat. Biomed. Eng. 2022"},
    "PsPG":                {"official": "PsPG",        "type": "VLM",  "citation": "Ye et al., PRCV 2024"},
    "BioViL-T":            {"official": "BioViL-T",    "type": "VLM",  "citation": "Bannur et al., CVPR 2023"},
    "DenseNet":            {"official": "DenseNet-121","type": "CNN",  "citation": "Cohen et al. (TorchXRayVision), MIDL 2022"},
    "Resnet":              {"official": "ResNet-50",   "type": "CNN",  "citation": "Cohen et al. (TorchXRayVision), MIDL 2022"},
    "XRayDar":             {"official": "X-Raydar",    "type": "CNN",  "citation": "Dyer et al., Lancet Digit. Health 2023"},
    "CheXagent-AutoGluon": {"official": "CheXagent-AG","type": "GEN+", "citation": "Chen et al. 2024 + AutoGluon booster"},
    "CheXagent":           {"official": "CheXagent",   "type": "GEN",  "citation": "Chen et al., arXiv:2401.12208 (2024)"},
}

# --- metric metadata --------------------------------------------------------
# direction: 'up' = higher is better. range: clamp for color scales.
METRIC_META = {
    "auroc":          {"label": "AUROC",                "short": "AUROC",       "desc": "Area under the ROC curve.", "direction": "up", "range": [0.5, 1.0]},
    "auprc":          {"label": "AUPRC",                "short": "AUPRC",       "desc": "Area under the precision-recall curve (average precision).", "direction": "up", "range": [0.0, 1.0]},
    "sens_at_95spec": {"label": "Sensitivity @ 95% specificity", "short": "Sens@95Spec", "desc": "Sensitivity at the operating point where specificity is at least 95%.", "direction": "up", "range": [0.0, 1.0]},
    "spec_at_95sens": {"label": "Specificity @ 95% sensitivity", "short": "Spec@95Sens", "desc": "Specificity at the operating point where sensitivity is at least 95% (screening-style).", "direction": "up", "range": [0.0, 1.0]},
    "ppv_at_95sens":  {"label": "PPV @ 95% sensitivity", "short": "PPV@95Sens",  "desc": "Positive predictive value at the >=95%-sensitivity operating point.", "direction": "up", "range": [0.0, 1.0]},
    "npv_at_95sens":  {"label": "NPV @ 95% sensitivity", "short": "NPV@95Sens",  "desc": "Negative predictive value at the >=95%-sensitivity operating point.", "direction": "up", "range": [0.0, 1.0]},
    "sensitivity":    {"label": "Sensitivity (Youden)",  "short": "Sensitivity", "desc": "Sensitivity at the Youden-J operating point. Available for binary-output models.", "direction": "up", "range": [0.0, 1.0]},
    "specificity":    {"label": "Specificity (Youden)",  "short": "Specificity", "desc": "Specificity at the Youden-J operating point. Available for binary-output models.", "direction": "up", "range": [0.0, 1.0]},
}


# ── provenance / sync ──────────────────────────────────────────────────────
# The site data is a pure derivative of the manuscript summary parquet; that file
# is the single source of truth and the site never reads it directly. We stamp the
# source's signature into the JSON so drift between the two is detectable.
def _file_sig(path: Path) -> dict:
    h = hashlib.sha1()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    stat = path.stat()
    return {
        "path": str(path.relative_to(REPO_ROOT)),
        "bytes": stat.st_size,
        "mtime": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(timespec="seconds"),
        "sha1": h.hexdigest(),
    }


def _git_rev() -> str | None:
    try:
        return subprocess.check_output(
            ["git", "-C", str(REPO_ROOT), "rev-parse", "--short", "HEAD"],
            stderr=subprocess.DEVNULL, text=True).strip()
    except Exception:
        return None


def provenance(n_rows: int) -> dict:
    return {
        "source": _file_sig(cfg.SUMMARY_LONG),
        "git_rev": _git_rev(),
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "n_rows": n_rows,
        "builder": "build_data.py",
    }


def check_sync() -> int:
    """Return 0 if site/data is in sync with the current summary parquet, else 1.
    Compares the stored source signature against the live parquet's signature."""
    lb = SITE_DATA / "leaderboard.json"
    if not lb.exists():
        print("OUT OF SYNC: site/data/leaderboard.json does not exist — run build_data.py")
        return 1
    stored = json.loads(lb.read_text()).get("provenance", {}).get("source", {})
    live = _file_sig(cfg.SUMMARY_LONG)
    if stored.get("sha1") == live["sha1"]:
        print(f"IN SYNC: site data matches summary ({live['path']}, {live['sha1'][:10]}, "
              f"built {json.loads(lb.read_text()).get('provenance', {}).get('built_at', '?')}).")
        return 0
    print("OUT OF SYNC: summary parquet has changed since the site data was built.")
    print(f"  stored sha1: {stored.get('sha1', '—')}  ({stored.get('mtime', '?')})")
    print(f"  live   sha1: {live['sha1']}  ({live['mtime']})")
    print("  -> re-run:  python build_data.py")
    return 1


def load_long() -> pd.DataFrame:
    """All three strata of the summary, region/country re-derived from config,
    Nanjing-MH pooled, public/private tagged. Mirrors ``_common.load_overall``
    but keeps the adult/pediatric slices too."""
    df = pd.read_parquet(cfg.SUMMARY_LONG)
    df["region"] = df["dataset_slug"].map(cfg.dataset_region)
    df["country"] = df["dataset_slug"].map(cfg.dataset_country)

    frames = []
    for (dim, grp), stratum in STRATA.items():
        sl = df[(df["dimension"] == dim) & (df["group"] == grp)].copy()
        if sl.empty:
            continue
        sl = common.merge_nanjing_mh(sl)          # pool the 3 MH subsets
        sl["stratum"] = stratum
        frames.append(sl)
    out = pd.concat(frames, ignore_index=True)
    out["scope"] = np.where(out["dataset"].isin(common.PRIVATE_DATASETS), "Private", "Public")
    return out


def main() -> None:
    df = load_long()
    df = df[df["metric"].isin(METRICS) & df["value"].notna()].copy()
    # Map to official dataset names once, AFTER pooling/scope (which key on the
    # internal names), so leaderboard.json and meta.json share one filter key.
    df["dataset"] = df["dataset"].map(common.ds_disp)

    # Category tags (canonical task + anatomy + extent), then prevalence Common/Rare.
    df = tc.add_category_columns(df)            # adds task_c, anatomy, extent
    prev_src = df[(df["stratum"] == "overall") & (df["metric"] == "auroc")]
    prev_map = tc.assign_prevalence(prev_src)   # task_c -> 'Rare'/'Common'
    prev_val = tc.task_prevalence(prev_src)     # task_c -> prevalence float
    df["prevalence"] = df["task_c"].map(prev_map).fillna("Common")

    # --- columnar leaderboard table -----------------------------------------
    df = df.sort_values(["metric", "model", "dataset", "pathology", "stratum"])
    rec = {
        "model":      df["model"].tolist(),
        "dataset":    df["dataset"].tolist(),                      # official names (mapped above)
        "region":     df["region"].tolist(),
        "country":    df["country"].tolist(),
        "scope":      df["scope"].tolist(),
        "pathology":  df["pathology"].tolist(),
        "task":       df["task_c"].tolist(),                       # canonical concept
        "anatomy":    df["anatomy"].tolist(),
        "extent":     df["extent"].tolist(),
        "prevalence": df["prevalence"].tolist(),
        "metric":     df["metric"].tolist(),
        "stratum":    df["stratum"].tolist(),
        "value":      [round(float(v), 4) for v in df["value"]],
        "ci_low":     [None if pd.isna(v) else round(float(v), 4) for v in df["ci_low"]],
        "ci_high":    [None if pd.isna(v) else round(float(v), 4) for v in df["ci_high"]],
        "n_pos":      [None if pd.isna(v) else int(v) for v in df["n_pos"]],
        "n_neg":      [None if pd.isna(v) else int(v) for v in df["n_neg"]],
    }
    prov = provenance(len(df))
    leaderboard = {"provenance": prov, "n_rows": len(df), "columns": list(rec.keys()), "data": rec}

    # --- meta ----------------------------------------------------------------
    # datasets present after pooling, with official name / geography / scope / N.
    ds_rows = []
    for ds, g in df.groupby("dataset"):
        # cohort N ~= the largest per-pathology evaluated count in this cohort.
        n = int((g["n_pos"].fillna(0) + g["n_neg"].fillna(0)).max())
        ds_rows.append({
            "name": ds,
            "region": g["region"].iloc[0],
            "country": g["country"].iloc[0],
            "scope": g["scope"].iloc[0],
            "n": n,
            "n_tasks": int(g["pathology"].nunique()),
        })
    ds_rows.sort(key=lambda d: (d["scope"], d["region"], d["name"]))

    models_present = [m for m in MODEL_META if m in set(df["model"])]
    model_rows = []
    for m in models_present:
        meta = MODEL_META[m]
        has = sorted(df[df["model"] == m]["metric"].unique().tolist())
        model_rows.append({
            "key": m,
            "official": meta["official"],
            "type": meta["type"],
            "citation": meta["citation"],
            "color": common.MODEL_COLOR.get(m, "#666666"),
            "is_binary": m == "CheXagent",
            "metrics": has,
        })

    meta = {
        "provenance": prov,
        "metrics": [{"key": k, **METRIC_META[k]} for k in METRICS],
        "models": model_rows,
        "datasets": ds_rows,
        "regions": sorted(df["region"].unique().tolist()),
        # only strata that actually have rows, in canonical order
        "strata": [{"key": s, "label": STRATUM_LABEL[s]}
                   for s in ["overall", "<18", "18-65", "65+"] if s in set(df["stratum"])],
        "category_schemes": {
            "anatomy":    {"label": "Anatomical system", "order": tc.ANATOMY_ORDER},
            "extent":     {"label": "Spatial extent",    "order": tc.EXTENT_ORDER},
            "prevalence": {"label": "Prevalence (<5% = rare)", "order": tc.PREVALENCE_ORDER},
        },
        "task_prevalence": {t: round(float(v), 4) for t, v in prev_val.items()},
    }

    SITE_DATA.mkdir(parents=True, exist_ok=True)
    (SITE_DATA / "leaderboard.json").write_text(json.dumps(leaderboard, separators=(",", ":")))
    (SITE_DATA / "meta.json").write_text(json.dumps(meta, indent=2))

    lb_kb = (SITE_DATA / "leaderboard.json").stat().st_size / 1024
    print(f"wrote leaderboard.json  ({len(df):,} rows, {lb_kb:,.0f} KB)")
    print(f"wrote meta.json         ({len(model_rows)} models, {len(ds_rows)} datasets, "
          f"{len(METRICS)} metrics)")
    print(f"  source:   {prov['source']['path']}  sha1={prov['source']['sha1'][:10]}  git={prov['git_rev']}")
    print(f"  models:   {', '.join(models_present)}")
    print(f"  datasets: {', '.join(d['name'] for d in ds_rows)}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Build the static leaderboard data from the manuscript summary.")
    ap.add_argument("--check", action="store_true",
                    help="report whether site/data is in sync with the summary parquet (no rebuild); exit 1 if stale.")
    args = ap.parse_args()
    if args.check:
        sys.exit(check_sync())
    main()
