# Oranosis v1

**Offline, interpretable decision support for peripheral exophytic oral lesions: a ranked differential diagnosis of 36 lesions and a four-tier malignancy-risk triage, computed from 14 descriptive clinical fields.**

**Live site: [oranosis.ir](https://oranosis.ir)** · the whole engine is in-memory JavaScript — no server, no API key, no internet connection needed after the first page load — and nothing that is typed into the tool leaves the device.

---

## Credits

**DDS, DMD Dr. Mohammad Reza Zeinali**
ORCID: [0009-0000-9635-4337](https://orcid.org/0009-0000-9635-4337)

School of Dentistry, Shahid Beheshti University of Medical Sciences, Tehran, Iran.
Concept, data, clinical knowledge base, model development, validation, software and documentation: the author.

---

## Abstract

**Objective.** To provide an interpretable, self-contained decision-support engine that converts a routine clinical description of a peripheral exophytic oral lesion into a ranked differential diagnosis and a malignancy-risk tier, and to document the evidence base and validation behind it.

**Methods.** A curated literature knowledge base (36 peripheral oral lesions; 19 malignancy red flags; WHO 2022, Neville 5th ed., Burket 13th ed.) was fused with 1,623 cases machine-extracted from 6,226 PubMed case reports and case series, and with 255 biopsy-confirmed lesions (227 patients, 21 malignant) from a university oral medicine department. Free text from the 14 standard clinical fields is parsed into 76 binary features with explicit negation and "unknown ≠ absent" handling. A hierarchical Bayesian classifier is fine-tuned discriminatively as a softmax regression and blended with a similarity-weighted nearest-neighbour vote over local cases. Malignancy risk combines a Bayesian logistic regression, whose prior is the literature red-flag set, with the differential's malignant mass, under a monotone safety constraint: adding a red flag can never lower the estimated risk. All settings and the three risk thresholds were selected by nested cross-validation; histopathology was the reference standard. Grok 4.5 and the clinicians who saw the same patients served as benchmarks.

**Results.** Oranosis placed the histopathologic diagnosis first in **61.8%** of 255 lesions and within the top three in **83.8%**, with a Cohen's κ of 0.532 and a malignancy **AUC of 0.953**. Top-3 agreement was higher than Grok 4.5 (78.4%; paired McNemar *P* = .04) and slightly above the clinicians' any-listed agreement (79.2%), who remained better at naming the single correct diagnosis (67.5%). At its safety-first tier the engine detected 20 of 21 cancers (sensitivity 95.2%, specificity 66.1%); the intermediate tier gave 87.3%/87.2% and the urgent tier 76.2%/96.4%. It never refuses to answer.

**Conclusions.** A knowledge-guided, literature-augmented probabilistic model can reach clinician-level malignancy sensitivity on a biopsy-confirmed series while remaining fully explainable and, unlike a large language model, fully offline. External, prospective and multicentre validation is still required.

**Keywords.** mouth neoplasms · oral pathology · clinical decision support · machine learning · Bayesian inference · squamous cell carcinoma

---

## 1. Introduction: what Oranosis v1 is

Peripheral exophytic lesions are among the most frequent specimens in an oral biopsy service. Most are reactive or benign — irritation fibroma, pyogenic granuloma, peripheral giant cell granuloma, epulis fissuratum, papilloma, mucocele — but a minority are malignant. Squamous cell carcinoma, verrucous carcinoma, lymphoma and metastases can all present as an exophytic mass and can mimic reactive lesions closely. Reported clinicopathological concordance for such lesions ranges from roughly 50% to 80%, access to oral medicine specialists is unevenly distributed, and a delayed diagnosis of oral cancer is associated with a more advanced stage at presentation.

Large language models have been proposed as diagnostic assistants, and in the 255-case series on which this tool was built, Grok 4.5 named the correct diagnosis first in 55.7% of lesions. That study also showed the structural problems of using a chat model for this task: outputs shift with model version and prompt wording, references may be fabricated, predictions cannot be calibrated to a local population, a small but critical fraction of cases is answered with "insufficient data", and the patient description has to be sent to an external server to obtain an answer at all. The last point alone makes routine clinical use unacceptable in most settings.

**Oranosis v1** is the alternative implemented as software. It is a transparent probabilistic engine that:

1. **encodes published clinical knowledge as a prior** — what 36 lesions look like, which features argue for and against each one, and which findings are malignancy red flags;
2. **learns from labelled presentations** — machine-extracted PubMed case reports and a local biopsy-confirmed series — instead of from free-form text generation;
3. **answers with a calibrated differential diagnosis** ranked by probability, each entry accompanied by its supporting and opposing features, a one-line clinical summary, bedside discriminators and citable references;
4. **adds an explicit safety layer** — a four-tier malignancy risk with a red-flag score, a monotone guarantee, and a rule that at or above the intermediate tier a malignant lesion is always present in the top three;
5. **runs entirely offline** in a single HTML file in the browser, or as a Python application on a local machine, so that no patient description ever leaves the device.

It is a research and teaching tool, not a medical device. It does not replace clinical judgement or biopsy.

---

## 2. Methodology

### 2.1 Study design and reference standard

Retrospective model development and internal validation. Development and reporting followed TRIPOD+AI and STARD 2015 principles. The protocol was approved by the Research Ethics Committee of the School of Dentistry, Shahid Beheshti University of Medical Sciences (IR.SBMU.DRC.REC.1404.076). Only archived, closed records were used, de-identified before analysis; no patient contact or intervention occurred. The reference standard was the final histopathologic diagnosis, standardised to the lesion categories of the knowledge base; malignant was defined as squamous cell carcinoma, lymphoma/malignant round-cell tumour or another malignant neoplasm.

### 2.2 Data sources

| Source | Content | Role |
|---|---|---|
| Literature knowledge base | 36 peripheral oral lesions; per-lesion prior, feature profile, summary, discriminators and references; 19 malignancy red flags with point weights; 10 protective features | Prior and explanation text |
| PubMed case database | 1,623 single-patient presentations extracted from 6,226 case reports / case series (37 lesion-specific searches) and 1,997 open-access full-text case sections | Likelihood refinement |
| Local database v1 | 255 biopsy-confirmed lesions from 227 patients, 21 malignant, described by the 14 clinical fields before biopsy | Discriminative fine-tuning, kNN reference set, validation |

Literature extraction is deliberately conservative. The label is taken from the article title, with the most specific lesion name winning and "X mimicking Y" labelled X; ambiguous, non-oral, animal, odontogenic/intraosseous and OPMD-only titles are excluded. Only sentences describing the patient's own presentation are retained — background definitions, histopathology, immunohistochemistry, treatment, follow-up and discussion are dropped — and **all lesion names are masked before features are read**, so that words such as *lobular*, *verrucous*, *granular* or *ossifying* cannot leak the answer. Automatic cases carry reduced weight (0.25–0.5) and are never used to estimate class frequencies, because case reports over-represent unusual presentations.

### 2.3 From text to features

The 14 clinical fields are free text in routine use, so the engine begins with a reader, not a form:

- maps free text to **76 binary standardised features** across 9 groups: site, colour, surface, base, consistency, size, age, sex, habits, duration, course, ulceration, bleeding, pain, paresthesia, lymph nodes, tooth mobility, bone change, diascopy, and others;
- handles **negation** both before and after a finding ("no pain", "painless"), with scope ending at contrastive conjunctions, and understands key aliases and units (age in months, size in mm);
- treats an empty field as **unknown, not absent**, so missing descriptors never act as reassuring evidence. Fewer than three of six core descriptors triggers an explicit "unreliable assessment" warning rather than a confident answer.

### 2.4 Differential diagnosis

**Stage 1 — hierarchical Bayesian classifier.** Each lesion's literature profile is the prior; PubMed cases then local cases update it (feature likelihoods, with smoothing). Class frequencies are taken only from the knowledge base and the local series.

**Stage 2 — discriminative fine-tuning.** The Bayesian model is rewritten exactly as a softmax regression and fine-tuned on the data with a ridge penalty that pulls it back towards the Bayesian solution, then blended (weight 0.3) with a similarity-weighted nearest-neighbour vote over local cases. The nearest-neighbour component captures feature combinations the literature cannot express, such as gingiva + purple + sessile → peripheral giant cell granuloma.

### 2.5 Malignancy risk and tiers

The risk is the mean of (a) a Bayesian logistic regression whose starting coefficients are the literature red flags (ulceration, induration/fixation, hard nodes, paresthesia, red-white colour, high-risk sites, tobacco/alcohol, age, size, rapid growth, tooth mobility, bone change) and (b) the total malignant probability of the differential.

Two safety constraints are always active:

- **sign constraints** — a literature red flag can never act as a reassuring feature;
- **monotone guard** — the estimated risk can never fall when a red flag is added (verified on 4,560 simulated additions).

Three thresholds are learned by cross-validation rather than fixed by hand:

| Tier | Rule used to select the threshold | Current value |
|---|---|---|
| **Borderline** (safety-first) | Highest threshold that keeps sensitivity ≥ 95% | ≥ 5% |
| **Intermediate** (prompt biopsy) | Expected-cost optimum, a missed cancer weighted 15× an unnecessary biopsy | ≥ 10% |
| **High** (urgent referral) | Threshold reaching specificity ≥ 97% | ≥ 20% |

A red-flag score ≥ 4 raises the tier to at least intermediate and ≥ 6 makes it high. At intermediate or high, a malignant diagnosis is always inserted into the top three. The engine never declines to answer.

### 2.6 Validation

Model selection and every reported figure come from **nested cross-validation** (10-fold × 3 repeats, n = 255): every setting, blend weight and risk threshold was chosen inside the training folds only, so the test cases never influenced any choice. Discrimination, agreement (Cohen's κ) and McNemar comparisons against Grok 4.5 and against the clinicians' recorded diagnoses were computed on the same 255 lesions; confidence intervals are Wilson intervals for proportions and Hanley–McNeil intervals for AUC.

| Model | Top-1 | Top-2 | Top-3 | κ |
|---|---|---|---|---|
| **Oranosis v1** (nested CV) | **61.8%** | 77.4% | **83.8%** | 0.532 |
| Grok 4.5 (same 255 cases) | 55.7% | – | 78.4% | 0.466 |
| Clinicians (oral medicine) | 67.5% | – | 79.2% (any listed) | 0.615 |

Malignancy triage on the 21 malignant lesions: AUC 0.953 (0.950–0.954), Brier 0.035; sensitivity/specificity 95.2%/66.1% (borderline), 87.3%/87.2% (intermediate) and 76.2%/96.4% (high). Top-3 agreement with histopathology was significantly higher than Grok 4.5 (McNemar *P* = .04); the top-1 difference was not significant. An external-validation scenario that never used a local label (knowledge base + PubMed cases only) still reached a malignancy AUC of 0.961, and the local fine-tuning is what raises differential accuracy to clinical level.

### 2.7 Reproducibility and quality assurance

Every published number is machine-checked against the data, the code and the deployed model:

- **paper ↔ software audit** — recomputes each checkable figure in the manuscript from the datasets, code, model and per-case predictions, and confirms the live code path reproduces the validation path on all 255 cases; must report 0 failures;
- **unit and regression tests** — feature reader, knowledge base, models, pipeline, engine, literature extraction, web server hardening and the browser edition;
- **self-test** — textbook cases, including the batch path;
- **stress testing** — 4,000 malformed records, invariance checks, clinical monotonicity, 40 reader phrasings, HTTP abuse and load;
- **Python ↔ JavaScript equivalence** — the browser engine is a line-by-line port; 45,900 inputs (local cases, vignettes, reader phrasings, red-flag additions, seeded fuzz records, random feature vectors, batch files and summation/rounding edge cases) produce identical features, differential, tier, safety insertion, red flags, warnings and advice, with 0 mismatches. The browser re-checks 24 built-in probes at every start;
- **determinism** — fixed seeds: retraining reproduces the deployed model, and the validation report, bit for bit.

### 2.8 Privacy architecture

The public build ships an **aggregate-only model**: no patient-level vectors, no narrative text and no identifiers. The build refuses to produce output otherwise, and an automated leak scan runs over every published file. Patient data, the research model and the source datasets are never part of the distributed site.

---

## 3. Using it

**Browser edition (recommended).** Open **[oranosis.ir](https://oranosis.ir)**, or `index.html` from this repository, in any modern browser. Fill in the 14 fields (or load one of the demonstration cases) and press *Analyse*. The application is also installable as a PWA and keeps working with the network switched off; the footer shows `offline file · self-test OK` when the internal checks pass. Four tabs are provided: *Assess* (differential, risk, explanations), *Library* (the 36 lesions), *Evidence* (the evidence library and references) and *About* (methods, limitations, disclaimer). The browser edition has no Batch tab; local CSV batches are handled by the Python package.

**Contents of this repository**

| File | Purpose |
|---|---|
| `index.html`, `app.js`, `app.css` | interface |
| `oranosis.js` | the engine: feature reader, models, pipeline, safety layer, explanations |
| `model.json` | public aggregate model (thresholds, coefficients) |
| `knowledge.json` | lesion library, red flags, references, reader vocabulary |
| `selftest.json` | 24 probes with the answers computed by the reference Python implementation |
| `performance.json` | validation results shown in the interface |
| `manifest.webmanifest`, `sw.js`, icons | installable offline PWA |
| `LICENSE` | MIT |

---

## 4. Limitations

- **Single centre.** The local series comes from one university department and contains 21 malignant lesions, so sensitivity intervals are wide (e.g. 95.2%, 95% CI 77–99%). External, prospective and multicentre validation is required before any clinical claim.
- **Text only.** No photographs, radiographs or histopathology images are used.
- **Clinically identical pairs.** Some lesions cannot be separated from clinical description alone (giant cell fibroma vs irritation fibroma: top-1 ≈ 22%). Histopathology remains the reference standard.
- **Rare lesions** are represented by few or no local cases and rely mainly on literature priors.
- **Automatically extracted literature cases** are noisier than expert abstraction, which is why they are down-weighted and never used for class frequencies.
- **Risk may under-estimate** in the highest-risk band; high-risk predictions are not a substitute for urgent biopsy.
- **Research and educational tool, not a medical device.** It does not replace clinical judgement, biopsy or specialist referral.

---

## 5. Citation and licence

If you use Oranosis v1 in academic work, please cite the software and the accompanying article on the agreement of a large language model with histopathologic diagnosis of peripheral exophytic oral lesions, and this repository.

Released under the **MIT licence** (see `LICENSE`). The clinical knowledge base, model and documentation are provided for research and teaching; no clinical warranty is given or implied.
