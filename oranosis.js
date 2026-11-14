/* Oranosis v1 - in-browser engine (plain ES module, no dependencies, no build step).
 *
 * Line-by-line port of the Python reference implementation (oranosis/features.py, models.py, pipeline.py, engine.py
 * and the batch code of server.py). Python stays the reference; web/equivalence_test.py checks that this port returns
 * the same features, rankings, tiers, safety insertions, red flags, warnings, advice and (to 1e-9 after rounding)
 * the same probabilities.
 *
 * Python-vs-JavaScript differences that are handled on purpose (see the "Py*" helpers):
 *   - \b \w \s \d are Unicode-aware in Python 3 `re` but ASCII-only (\w \d \b) in JavaScript: PX() translates them.
 *   - str.split()/strip()/isspace() use a different whitespace set than JS (\x1c-\x1f, \x85 yes; \ufeff no).
 *   - Python strings are indexed by code point, JS strings by UTF-16 unit: before()/after()/cpSlice().
 *   - float()/int() accept any Unicode decimal digit (Persian/Arabic-Indic numerals): asciiDigits().
 *   - sum() of floats has been compensated (Neumaier) since Python 3.12: pySum().
 *   - round(x, 4) / format(x, ".1f") round half to even on the exact binary value; toFixed rounds half up: pyRound().
 *   - sorted() is stable like Array.prototype.sort; dict order = insertion order (Map is used for records).
 *   - csv module: Sniffer, reader state machine and writer ported from CPython 3.15 (_csv.c / csv.py).
 */

/* Python compatibility helpers */
const WS = "\\t-\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000"; // str.isspace()
const WC = "\\p{L}\\p{N}_";                                                                          // Python \w
const BOUND = `(?:(?<=[${WC}])(?![${WC}])|(?<![${WC}])(?=[${WC}]))`;                                  // Python \b
const WS_RUN = new RegExp(`[${WS}]+`);
const WS_ENDS = new RegExp(`^[${WS}]+|[${WS}]+$`, "g");

/** Compile a Python `re` pattern (raw source) to an equivalent Unicode-aware JavaScript RegExp. */
export function PX(src, flags = "") {
  let out = "", cls = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      const n = src[++i];
      if (n === "b" && !cls) out += BOUND;
      else if (n === "w") out += cls ? WC : `[${WC}]`;
      else if (n === "s") out += cls ? WS : `[${WS}]`;
      else if (n === "d") out += "\\p{Nd}";
      else if (n === "B" || n === "W" || n === "S" || n === "D" || (n === "b" && cls)) throw new Error("unsupported escape \\" + n);
      else out += c + n;
    } else {
      if (c === "[") cls = true; else if (c === "]") cls = false;
      out += c;
    }
  }
  return new RegExp(out, flags + "u");
}
const _rxCache = new Map();
function G(src) {                       // cached global regex (finditer)
  let r = _rxCache.get(src);
  if (!r) { r = PX(src, "g"); _rxCache.set(src, r); }
  r.lastIndex = 0;
  return r;
}
const _rxCache1 = new Map();
function R(src) {                       // cached non-global regex (search / match)
  let r = _rxCache1.get(src);
  if (!r) { r = PX(src); _rxCache1.set(src, r); }
  return r;
}

const isHigh = c => c >= 0xd800 && c <= 0xdbff, isLow = c => c >= 0xdc00 && c <= 0xdfff;
/** Python text[max(0, idx - n):idx] with idx a UTF-16 index: n *code points* before idx. */
function before(s, idx, n) {
  let i = idx;
  while (n-- > 0 && i > 0) { i--; if (i > 0 && isLow(s.charCodeAt(i)) && isHigh(s.charCodeAt(i - 1))) i--; }
  return s.slice(i, idx);
}
/** Python text[idx:idx + n]: n code points from idx. */
function after(s, idx, n) {
  let i = idx; const L = s.length;
  while (n-- > 0 && i < L) { const c = s.charCodeAt(i++); if (isHigh(c) && i < L && isLow(s.charCodeAt(i))) i++; }
  return s.slice(idx, i);
}
/** Python s[:n] */
export const cpHead = (s, n) => (s.length <= n ? s : after(s, 0, n));
const pyStrip = s => s.replace(WS_ENDS, "");

// code points that are str.isdigit() but not category Nd (from unicodedata; checked over all code points by equivalence_test.py)
const DIGIT_EXTRA = [[0xB2, 0xB3], [0xB9, 0xB9], [0x1369, 0x1371], [0x19DA, 0x19DA], [0x2070, 0x2070], [0x2074, 0x2079],
  [0x2080, 0x2089], [0x2460, 0x2468], [0x2474, 0x247C], [0x2488, 0x2490], [0x24EA, 0x24EA], [0x24F5, 0x24FD],
  [0x24FF, 0x24FF], [0x2776, 0x277E], [0x2780, 0x2788], [0x278A, 0x2792], [0x10A40, 0x10A43], [0x10E60, 0x10E68],
  [0x11052, 0x1105A], [0x1F100, 0x1F10A]];
const ND = /^\p{Nd}$/u;
/** Python str.isdigit() for one character */
export function pyIsDigit(ch) {
  if (!ch) return false;
  if (ND.test(ch)) return true;
  const cp = ch.codePointAt(0);
  return DIGIT_EXTRA.some(([a, b]) => cp >= a && cp <= b);
}
/** Replace Unicode decimal digits by ASCII digits (what float()/int() do implicitly). */
export function asciiDigits(s) {
  if (!/[^\x00-\x7f]/.test(s)) return s;
  return s.replace(/\p{Nd}/gu, ch => {
    const cp = ch.codePointAt(0);
    if (cp < 128) return ch;
    let start = cp;
    while (start > 0 && ND.test(String.fromCodePoint(start - 1))) start--;
    return String((cp - start) % 10);
  });
}
const pyFloat = s => Number(asciiDigits(s));

/** CPython >= 3.12 sum() of floats: Neumaier-compensated; ints before the first float are exact. */
export function pySum(a) {
  if (a.length === 0) return 0;
  let f = a[0], c = 0.0;
  for (let i = 1; i < a.length; i++) {
    const x = a[i], t = f + x;
    if (Math.abs(f) >= Math.abs(x)) c += (f - t) + x; else c += (x - t) + f;
    f = t;
  }
  if (c !== 0 && Number.isFinite(c)) f += c;
  return f;
}

/** Python format(x, '.<nd>f') (round half to even on the exact value). */
export function pyFixed(x, nd) {
  if (!Number.isFinite(x)) return String(x);
  const neg = x < 0 || Object.is(x, -0), a = Math.abs(x);
  let s = a.toFixed(nd);                                   // exact decimal, ties rounded up
  const full = a.toFixed(Math.min(100, nd + 90));           // exact expansion of the double (enough digits to see a tie)
  const dot = full.indexOf(".");
  const tail = full.slice(dot + 1 + nd);
  if (tail[0] === "5" && /^0*$/.test(tail.slice(1))) {      // exact tie -> keep the even neighbour
    const trunc = nd === 0 ? full.slice(0, dot) : full.slice(0, dot + 1 + nd);
    if ((trunc.charCodeAt(trunc.length - 1) - 48) % 2 === 0) s = trunc;
  }
  return (neg ? "-" : "") + s;
}
/** Python round(x, nd) for floats. */
export function pyRound(x, nd) {
  if (!Number.isFinite(x)) return x;
  return Number(pyFixed(x, nd));
}
const pyFloatStr = v => (Number.isInteger(v) ? v.toFixed(1) : String(v));   // str(float) for the values used here

const mapGet = (m, k, d) => (m.has(k) ? m.get(k) : d);
const stableSort = (arr, key) => arr.map((v, i) => [v, i]).sort((p, q) => {
  const a = key(p[0]), b = key(q[0]);
  return a < b ? -1 : a > b ? 1 : p[1] - q[1];
}).map(p => p[0]);

/* features.py */
const NULLS = new Set(["", "null", "none", "nan", "not specified", "not available data", "n/a", "na", "-", "unknown",
  "not recorded", "not measured", "not known", "unk", "?"]);
const NEG = PX(String.raw`\b(no|not|never|without|non|denies|denied|absence of|negative for|free of)\b[\w\s/,-]{0,25}$`);
const NEG_SCOPE_END = PX(String.raw`^[^]*\b(but|however|although|though|yet|whereas|except)\b`);
const POST_NEG = PX(String.raw`^\w*\s*(?:[:=-]\s*)?(?:none|absent|nil|negative|not (?:present|seen|detected|observed|noted|found|` +
  String.raw`palpable|palpated|evident|enlarged)|non[- ]?palpable|impalpable)\b|^\w*\s*[:=]\s*no\b`);
const POST_NEG_NODE = PX(String.raw`^[\w\s:,=-]{0,20}?\b(?:none|absent|nil|negative|not (?:palpable|palpated|enlarged|involved|` +
  String.raw`present|detected)|non[- ]?palpable|impalpable|normal|unremarkable|wnl|within normal limits?)\b`);
const KEY_ALIASES = new Map(Object.entries({
  "size (mm)": "size(mm)", "size mm": "size(mm)", "size in mm": "size(mm)", "size": "size(mm)",
  "colour": "color", "surface": "texture", "site": "location", "habits": "patient habits",
  "history": "patient history", "extraoral": "extraoral findings", "extra oral findings": "extraoral findings",
  "number": "count", "additional": "additional data", "notes": "additional data", "gender": "sex"}));

const WS_UNDERSCORE = new RegExp(`[${WS}_]+`, "g");
export function normKey(k) {
  k = pyStrip(String(k)).toLowerCase().replace(WS_UNDERSCORE, " ").replace(/ \(/g, "(").replace(/\( /g, "(").replace(/ \)/g, ")");
  return KEY_ALIASES.has(k) ? KEY_ALIASES.get(k) : k;
}
function clean(v) {
  const s = (v === null || v === undefined ? "" : String(v)).toLowerCase().split(WS_RUN).filter(Boolean).join(" ");
  return NULLS.has(s) ? "" : s;
}
/** True if regex `pattern` occurs in text at least once without a negation before it (within its clause) or after it. */
function has(text, pattern, negatable = true, post = POST_NEG) {
  const re = G(pattern);
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === "") { re.lastIndex++; continue; }
    if (negatable) {
      let pre = before(text, m.index, 30);
      const cut = NEG_SCOPE_END.exec(pre);
      if (cut) pre = pre.slice(cut[0].length);
      if (NEG.test(pre) || (post !== null && post.test(after(text, m.index + m[0].length, 30)))) continue;
    }
    return true;
  }
  return false;
}
const search = (pattern, s) => R(pattern).test(s);

/** Age in years; '6 months' / '3 weeks' are converted; implausible values (> 120) are ignored. */
export function parseAgeYears(text) {
  const m = R(String.raw`\d+(\.\d+)?`).exec(text);
  if (!m) return null;
  let a = pyFloat(m[0]);
  const unit = after(text, m.index + m[0].length, 8);
  if (R(String.raw`^\s*(months?|mo\b|mos\b)`).test(unit)) a /= 12.0;
  else if (R(String.raw`^\s*(weeks?|wks?\b)`).test(unit)) a /= 52.0;
  else if (R(String.raw`^\s*(days?|d\b)`).test(unit)) a /= 365.0;
  return (a >= 0 && a <= 120) ? a : null;
}

/** Longest stated duration in months, or null. */
export function parseDurationMonths(text) {
  let best = null;
  const re = G(String.raw`(\d+(?:\.\d+)?)(?:\s*(?:-|to|or)\s*(\d+(?:\.\d+)?))?\s*` +
    String.raw`(day|days|d\b|week|weeks|wk|month|months|mo\b|year|years|yr|yrs|y\b)`);
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = pyFloat(m[2] || m[1]);
    const unit = m[3];
    let months;
    if (unit.startsWith("d")) months = n / 30.0;
    else if (unit.startsWith("w")) months = n / 4.3;
    else if (unit.startsWith("m")) months = n;
    else months = n * 12;
    const clause = before(text, m.index, 40).split(/[,;.|]/).pop();    // same clause only
    if (after(text, m.index + m[0].length, 6).includes("ago") && search("(surgery|extraction|excis|biops)", clause)) continue;
    best = best === null ? months : Math.max(best, months);
  }
  if (best === null) {
    if (search(String.raw`\b(a|one) (month)\b`, text)) best = 1.0;
    else if (search(String.raw`\b(a|one) (year)\b`, text)) best = 12.0;
    else if (search(String.raw`\b(few|several) (days|weeks)\b`, text)) best = 0.5;
    else if (search(String.raw`\b(few|several) months\b`, text)) best = 3.0;
    else if (search(String.raw`\b(few|several|many) years\b`, text)) best = 36.0;
  }
  return best;
}

/** Largest dimension in mm from strings like '10*10', '10x5', '1.5 cm', '2 mm'. */
export function parseSizeMm(text) {
  if (!text) return null;
  const t = text.split(",").join(".");
  let nums = [];
  const re = G(String.raw`(\d+(?:\.\d+)?)\s*(cm|mm)?`);
  let m;
  while ((m = re.exec(t)) !== null) {
    let v = pyFloat(m[1]);
    const unit = m[2];
    if (unit === "cm" || (unit === undefined && t.includes("cm") && !t.includes("mm"))) v *= 10;
    nums.push(v);
  }
  nums = nums.filter(n => n > 0 && n < 150);
  return nums.length ? Math.max(...nums) : null;
}

const NEUTRAL = String.raw`\b(hard|soft) (palate|tissues?)\b|\bfixed (prosthe\w*|bridge|partial\w*|orthodontic\w*|appliance|denture|retainer)`;
const NEUTRAL_RE = PX(NEUTRAL, "g");
const neutral = s => s.replace(NEUTRAL_RE, "_");
const anyIn = (x, list) => list.some(f => x[f]);

/** record: Map | array of [key, value] pairs | plain object (14 thesis fields, keys case-insensitive).
 *  Clinical mode only (text_mode=False). Returns {x, observed (Set), age, size_mm, duration_m, completeness, missing_core}. */
export function extract(record, K) {
  const FEATURES = K.FEATURES, GROUPS = K.GROUPS;
  const entries = record instanceof Map ? [...record] : Array.isArray(record) ? record : Object.entries(record);
  const r = new Map();
  for (const [k0, v] of entries) {
    const k = normKey(k0);
    if (!r.has(k) || !clean(r.get(k))) r.set(k, v);     // first non-empty value wins for duplicate/alias keys
  }
  const g = k => (r.has(k) ? clean(r.get(k)) : "");
  const age_s = g("age"), sex = g("sex");
  const habits = g("patient habits"), hist = g("patient history"), extra = g("extraoral findings");
  const tex = g("texture"), col = g("color"), base = g("base");
  const cnt = g("count"), loc = g("location"), size_s = g("size(mm)");
  const cons = g("consistency"), add = g("additional data");
  const x = {};
  for (const f of FEATURES) x[f] = 0;
  const observed = new Set();
  const allt = [habits, hist, extra, tex, col, base, cnt, loc, cons, add].join(" | ");
  const bg = [habits, hist, add].join(" | ");     // background text

  // --- demographics
  const age = parseAgeYears(age_s);
  if (age !== null) {
    observed.add("age");
    x[age < 20 ? "age_lt20" : age < 40 ? "age_20_39" : age < 60 ? "age_40_59" : "age_ge60"] = 1;
  }
  if (sex) {
    if (sex.startsWith("m") || sex === "male" || sex === "man") { x.sex_m = 1; observed.add("sex"); }
    else if (sex.startsWith("f") || sex === "female" || sex === "woman") { x.sex_f = 1; observed.add("sex"); }
  }

  // --- habits / background
  if (has(bg, String.raw`(smok|cigar|hookah|qalyan|ghalyan|waterpipe|water pipe|opium|tobacco|pipe|snuff|naswar|betel|areca|paan)`)) x.tobacco = 1;
  if (has(bg, String.raw`(alcohol|ethanol|liquor|\bdrinker|heavy drinking|drinks? (alcohol|beer|wine|spirits)|\bbeer\b|\bwine\b)`)) x.alcohol = 1;
  if (has(allt, String.raw`(denture|prosthe|flange|obturator)`)) x.denture = 1;
  if (has(bg, String.raw`(mouth breath|oral breath|mouthbreath)`)) x.mouth_breather = 1;
  if (has(bg, String.raw`(pregnan|gestation|post ?partum|breastfeed|oral contraceptive)`)) x.pregnancy = 1;
  if (has(bg, String.raw`(cheek bit|lip bit|tongue bit|biting|chewing habit|bruxism|clench|sucking|habitual|ill[- ]fitting|loose denture|sharp (tooth|edge|cusp)|broken tooth|fractured tooth|overhang)`)) x.chronic_trauma = 1;
  if (has(bg, String.raw`(methotrexate|metotrox|prednisol|cortico|steroid|cyclosporin|tacrolimus|azathioprin|mycophenol|hiv|aids|transplant|chemotherap|immunosupp|immunodef)`)) x.immunosuppression = 1;
  if (has(bg, String.raw`(phenytoin|dilantin|cyclosporin|nifedipin|amlodipin|verapamil|diltiazem|felodipin|valpro)`)) x.gingival_overgrowth_drug = 1;
  {
    const re = G(String.raw`(cancer|malignan|carcinoma|lymphoma|leukemia|leukaemia|sarcoma|melanoma|radiotherapy)`);
    let mm;
    while ((mm = re.exec(bg)) !== null) {
      if (!search(String.raw`(family|mother|father|sister|brother|parent|son|daughter|aunt|uncle)`, before(bg, mm.index, 30))) {
        x.cancer_history = 1;
        break;
      }
    }
  }

  // --- history / course
  const dur = parseDurationMonths(hist + " | " + add);
  if (dur !== null) {
    observed.add("duration");
    x[dur < 1 ? "dur_lt1m" : dur <= 6 ? "dur_1_6m" : dur <= 12 ? "dur_6_12m" : "dur_gt1y"] = 1;
  }
  if (has(allt, String.raw`(rapid|fast|quick|sudden(ly)? (grow|enlarg|increas))`)) x.rapid_growth = 1;
  if (has(allt, String.raw`(progress|grow|grew|enlarg|increas(ed|ing)? in size|gradual|expan)`)) x.progressive_growth = 1;
  if (has(allt, String.raw`(stable|no change|unchanged|not changed|same size|constant size|didn.?t change|without change)`, false)) x.stable_size = 1;
  if (has(allt, String.raw`(fluctuat|regress|rupture|popp|discharg|burst|drain|periodic|comes and goes|size change|disappear|reappear|mucus|gelatinous)`)) x.fluctuating_size = 1;
  if (has(allt, String.raw`(recur|similar lesion|previously excised|excised .{0,20}ago|re-?grow|again)`)) x.recurrence = 1;
  if (has(allt, String.raw`(extraction|extracted|socket|after removal of (the )?tooth)`)) x.post_extraction = 1;
  if (has(allt, String.raw`(trauma|bite|biting|bitten|injur|hit by|accident|burn by|scratch)`)) x.trauma_history = 1;
  if (has(allt, String.raw`(bleed|bled|hemorrh|haemorrh|blood)`)) x.bleeding = 1;
  const explicit_pain = has(allt, String.raw`(painful|pain (on|during|when|with|in)|severe pain|tender|burning|\bsore\b|\bache)`);
  const generic_pain = has(allt, String.raw`\bpain\b|discomfort`);
  if (explicit_pain || (generic_pain && !search(String.raw`(painless|asymptomatic)`, allt))) x.pain = 1;
  if (has(allt, String.raw`(par[ae]sth|numb|anesthesia|anaesthesia|tingling|hypoesth|dysesth)`)) x.paresthesia = 1;

  // --- extraoral
  if (extra && !search(String.raw`^(?:(normal|nl|nothing|wnl|within normal limits?|non|no|-)\.?)$`, extra)) {
    if (has(extra, String.raw`(lymph|node|lad\b|adenopath)`, true, POST_NEG_NODE)) {
      x.lymphadenopathy = 1;
      if (search(String.raw`(hard|fixed|non ?-?mobile|immobile|matted|indurat)`, extra)) x.lymph_fixed_hard = 1;
    }
    if (has(extra, String.raw`(swelling|asymmetr|asymetr|enlarge|mass)`)) x.facial_swelling = 1;
  }

  // --- surface / texture
  if (tex) observed.add("surface");
  if (has(tex, String.raw`smooth`)) x.surf_smooth = 1;
  if (has(tex + " " + base, String.raw`(lob|lub|multi ?lobular|bosselat|basselat)`)) x.surf_lobulated = 1;
  if (has(tex + " " + col + " " + add, String.raw`(verruc|papill|warty|wart|cauliflower|finger|frond|spiky|projection)`)) x.surf_verrucous_papillary = 1;
  if (has(tex, String.raw`granul`)) x.surf_granular = 1;
  if (has(tex, String.raw`(rough|irregular|bumpy)`)) x.surf_rough = 1;
  if (has(tex + " | " + col + " | " + base + " | " + add, String.raw`(ulcer|erosi|eroded|crater)`)) x.ulceration = 1;
  if (has(tex + " | " + col + " | " + add, String.raw`(kerat|leukoplak|hyperkerat)`)) x.keratosis = 1;
  if (has(allt, String.raw`(pseudomembran|fibrin|slough)`)) x.pseudomembrane = 1;

  // --- color
  if (col) observed.add("color");
  if (has(col, String.raw`(pink|normal|mucosa colou?r|same as)`)) x.col_pink = 1;
  if (has(col, String.raw`\b(red|reddish|redd\w*|erythem\w*|hemorrhagic|haemorrhagic)\b`)) x.col_red = 1;
  if (has(col, String.raw`\b(purpl\w*|blue|bluish|violac\w*|cyan\w*|livid)`)) x.col_purple_blue = 1;
  if (has(col, String.raw`\b(white|whitish|pale|keratotic|kerat\w*|grey|gray|greyish|grayish)\b`)) x.col_white = 1;
  if (has(col, String.raw`\byellow\w*`)) x.col_yellow = 1;
  if (has(col, String.raw`\b(brown\w*|black\w*|pigmented|pigmentation|melanotic|dark)\b`)) x.col_pigmented = 1;
  if (x.col_red && x.col_white) x.col_red_white = 1;

  // --- base / mobility
  if (base) observed.add("base");
  const bb = base.split("-").join(" ");
  if (search(String.raw`(?<!non )(?<!non)pedunc`, bb) && !search(String.raw`non ?pedunc`, bb)) x.base_pedunculated = 1;
  if (search(String.raw`(sessile|broad|non ?pedunc|wide base|flat)`, bb)) x.base_sessile = 1;
  if (search(String.raw`(dome|nodul|round)`, bb)) x.base_dome = 1;
  if (has(neutral(base + " | " + cons + " | " + add), String.raw`(non ?-?mobile|not mobile|immobile|fixed|indurat|infiltrat|attached to underlying)`)) x.fixed_indurated = 1;

  // --- count
  {
    const m = R(String.raw`\d+`).exec(cnt);
    // int(m) > 1 without big-number conversion: any digit string other than 0, 00.., 1, 01..
    if ((m && !/^0*[01]$/.test(asciiDigits(m[0]))) || search(String.raw`(multiple|more|several|bilateral|wide|generali|diffuse)`, cnt + " " + loc)) x.multiple = 1;
  }

  // --- site (multi-label)
  if (loc) observed.add("site");
  const L = loc.split("latral").join("lateral").split("dosal").join("dorsal").split("dosral").join("dorsal")
    .split("mocusa").join("mucosa").split("mucusa").join("mucosa").split("vesitbule").join("vestibule")
    .split("vestubule").join("vestibule").split("commisure").join("commissure");
  if (search(String.raw`tongue|dorsal surface|dorsum`, L)) {
    if (search(String.raw`(lateral|border|ventral|under ?surface|side of (the )?tongue)`, L)) x.site_tongue_lateral_ventral = 1;
    else x.site_tongue_dorsum = 1;
  }
  if (search(String.raw`(floor of (the )?mouth|lingual frenum|sublingual)`, L)) x.site_floor = 1;
  if (search(String.raw`(palat|palate)`, L) && !search(String.raw`palatal (marginal )?gingiv|palatal surface of|palatal ridge`, L)) x.site_palate = 1;
  if (search(String.raw`(lower lip|lip lower|mandibular labial|labial mucosa of mandib|inner surface of lower lip|vermil)`, L)) x.site_lip_lower = 1;
  else if (search(String.raw`(upper lip|maxillary labial mucosa|labial mucosa of maxill)`, L)) x.site_lip_upper = 1;
  else if (search(String.raw`\blips?\b|labial mucosa`, L) && !search(String.raw`gingiv`, L)) x.site_lip_lower = 1;
  if (search(String.raw`(buccal mucosa|cheek|linea alba|lina alba|occlusion line|occlusal line|commissur|retrocornmiss|retrocommiss|oral mucosa)`, L) ||
      search(String.raw`buccal (side|surface) parallel`, L)) x.site_buccal = 1;
  if (search(String.raw`(retromolar|retro-molar)`, L) && !x.site_buccal) x.site_retromolar = 1;
  if (search(String.raw`(vestib|flange|sulcus)`, L)) x.site_vestibule = 1;
  if (search(String.raw`(gingiv|papilla|interdental|marginal|attached)`, L)) x.site_gingiva = 1;
  if (search(String.raw`(ridge|edentul|extract|socket|tuberosit|alveolar|residual root|eruption site)`, L)) x.site_alveolar_edentulous = 1;
  if (!anyIn(x, GROUPS.site) && search(String.raw`(incisor|canine|premolar|molar|tooth|teeth|maxilla|mandib|anterior region|\b[1-8]\b)`, L)) x.site_gingiva = 1;
  if (loc && !anyIn(x, GROUPS.site)) observed.delete("site");

  // --- size
  const size = parseSizeMm(size_s);
  if (size !== null) {
    observed.add("size");
    x[size <= 5 ? "size_le5" : size <= 10 ? "size_6_10" : size <= 20 ? "size_11_20" : "size_gt20"] = 1;
  }

  // --- consistency
  if (cons) observed.add("consistency");
  const cn = neutral(cons), an = neutral(add);
  if (has(cn, String.raw`soft`)) x.cons_soft = 1;
  if (has(cn, String.raw`rubber`)) x.cons_rubbery = 1;
  if (has(cn, String.raw`(firm|fim|fibrot|fibrous)`)) x.cons_firm = 1;
  if (has(cn + " | " + an, String.raw`(hard|bony|stony|indurat)`)) x.cons_hard = 1;
  if (has(cn + " | " + an, String.raw`(fluctu|cystic|compressib|spongy)`)) x.cons_fluctuant = 1;
  if (cons && !anyIn(x, GROUPS.consistency)) observed.delete("consistency");

  // --- additional exam
  if (has(allt, String.raw`((tooth|teeth) (mobility|mobile|displac|migrat|move|separat)|(mobility|displacement|migration) of (the )?(tooth|teeth)|teeth to move|diastema|tooth mobility)`)) x.tooth_mobility_displacement = 1;
  if (has(allt, String.raw`(bone (loss|resorption|destruction|erosion|involve)|radiolucen|cup(ped)? shaped resorption|saucer|osteolys)`)) x.bone_involvement = 1;
  if (has(allt, String.raw`(calcif|radiopa|ossif)`)) x.calcification = 1;
  if (has(allt, String.raw`(blanch|diascopy (is )?positive|diascopy\s*\+|positive diascopy|compress(ible)? and refill)`)) x.blanching = 1;

  const present = { "texture": tex, "color": col, "base": base, "location": loc, "size(mm)": size_s, "consistency": cons };
  const missing = K.CORE_FIELDS.filter(k => !present[k]);
  return { x, observed, age, size_mm: size, duration_m: dur, completeness: 1 - missing.length / K.CORE_FIELDS.length, missing_core: missing };
}

/* models.py / pipeline.py / engine.py */
const ADVICE = {
  low: "Remove the irritant and review. Biopsy if it persists beyond 2-3 weeks; send any excised tissue for histopathology.",
  borderline: "Remove irritants and re-examine within 2 weeks. Low threshold for biopsy.",
  intermediate: "Prompt biopsy and specialist assessment.",
  high: "Urgent referral for biopsy (suspected-cancer pathway).",
};
const DISCLAIMER = "Decision support only. Histopathology is the reference standard.";

export class Oranosis {
  /** doc: the model JSON ({meta, model}); K: knowledge.json.
   *  opts.allowKnn: accept the research model (per-case kNN store = patient-level vectors). Off by default: the browser
   *  edition must never load patient-level data; the switch exists only so the port can be verified locally in Node. */
  constructor(doc, K, opts = {}) {
    const d = doc.model;
    this.K = K;
    this.meta = doc.meta || {};
    const store = d.knn_store || [];
    if (store.length && !opts.allowKnn) throw new Error("models with a kNN store (per-case vectors, research model) are refused by the browser edition");
    this.store = store.map(t => ({ tp: new Set(t.p), to: new Set(t.o), label: t.label }));
    this.cfg = Object.assign({}, d.cfg || {});
    if (!("safety" in this.cfg)) this.cfg.safety = false;      // models saved before the option existed were unconstrained
    const FEATURES = this.FEATURES = K.FEATURES;
    this.classes = K.LESIONS.map(l => l.id);
    this.byId = new Map(K.LESIONS.map(l => [l.id, l]));
    this.malig = new Set(K.MALIGNANT_IDS);
    this.isMal = this.classes.map(c => this.malig.has(c));
    this.groupNames = Object.keys(K.GROUPS);
    this.featGroup = FEATURES.map(f => { for (const g of this.groupNames) if (K.GROUPS[g].includes(f)) return g; return null; });
    this.redFlagFeatures = K.RED_FLAGS.map(t => t[0]);
    // differential (naive Bayes): theta kept for explain(); full scoring path kept for models without a softmax stage
    const nb = d.differential;
    this.nb = { k: nb.k, k_prior: nb.k_prior, T: nb.T, theta: nb.theta, log_prior: nb.log_prior };
    // discriminative (softmax) stage
    this.sm = null;
    if (d.discriminative) {
      const cols = FEATURES.concat(this.groupNames.map(g => "miss_" + g));
      this.cols = cols;
      this.W = this.classes.map(c => Float64Array.from(cols.map(k => d.discriminative.W[c][k])));
      this.b = this.classes.map(c => d.discriminative.b[c]);
      this.sm = true;
    }
    // malignancy model
    this.lr = { b0: d.malignancy.b0, beta: FEATURES.map(f => d.malignancy.beta[f]) };
    const cg = (k, dflt) => (k in this.cfg ? this.cfg[k] : dflt);          // dict.get(key, default)
    this.t_int = cg("thr_intermediate", K.TIER_INTERMEDIATE);
    this.t_high = cg("thr_high", K.TIER_HIGH);
    this.t_watch = Math.min(cg("thr_watch", K.TIER_WATCH), this.t_int);
    this._logT = null;
    this.guardFlagCap = K.MAX_GUARD_FLAGS;
  }

  usable(fi, observed) { const g = this.featGroup[fi]; return g === null || observed.has(g); }

  /* DifferentialModel.scores */
  nbScores(x, observed) {
    const F = this.FEATURES, T = this.nb.theta;
    return this.classes.map((c, ci) => {
      let s = this.nb.log_prior[c];
      const th = T[c];
      for (let fi = 0; fi < F.length; fi++) {
        if (!this.usable(fi, observed)) continue;
        const t = th[F[fi]];
        s += x[F[fi]] ? Math.log(t) : Math.log(1 - t);
      }
      return s;
    });
  }
  /* DiscriminativeDifferential.scores: b + sum(v*w for the non-zero design-row columns) */
  smScores(x, observed) {
    const F = this.FEATURES, active = [];
    for (let fi = 0; fi < F.length; fi++) if (this.usable(fi, observed) && x[F[fi]]) active.push(fi);
    for (let gi = 0; gi < this.groupNames.length; gi++) if (!observed.has(this.groupNames[gi])) active.push(F.length + gi);
    return this.classes.map((c, ci) => {
      const w = this.W[ci], vals = new Array(active.length);
      for (let i = 0; i < active.length; i++) vals[i] = 1.0 * w[active[i]];
      return this.b[ci] + pySum(vals);
    });
  }
  /* model.predict -> ranked [[classIndex, prob], ...] (stable sort by -prob) */
  rankedProbs(x, observed) {
    const sc = this.sm ? this.smScores(x, observed) : this.nbScores(x, observed);
    let m = sc[0];
    for (const s of sc) if (s > m) m = s;
    const ex = sc.map(s => Math.exp(this.sm ? s - m : (s - m) / this.nb.T));
    const z = pySum(ex);
    const probs = ex.map(v => v / z);
    return stableSort(probs.map((p, i) => [i, p]), kv => -kv[1]);
  }
  /* pipeline.knn_probs (research model only): similarity-weighted nearest neighbours over the stored training cases */
  knnProbs(x, observed, k) {
    const F = this.FEATURES, pos = new Set(F.filter(f => x[f]));
    const groupOf = new Map(F.map((f, i) => [f, this.featGroup[i]]));
    const sims = this.store.map(t => {
      let num = 0, den = 0;
      for (const f of new Set([...pos, ...t.tp])) {
        const g = groupOf.get(f) || null;
        if (g && (!observed.has(g) || !t.to.has(g))) continue;
        den += 1;
        if (pos.has(f) && t.tp.has(f)) num += 1;
      }
      return [den ? num / den : 0.0, t.label];
    });
    const p = new Map();
    for (const [s, lab] of stableSort(sims, v => -v[0]).slice(0, k)) p.set(lab, (p.has(lab) ? p.get(lab) : 0.0) + Math.exp(4 * s));
    const z = pySum([...p.values()]) || 1.0;
    return this.classes.map(c => (p.has(c) ? p.get(c) : 0.0) / z);
  }
  /* Fitted.diff_probs: [[classIndex, prob], ...] in the order of the model's ranking (before any kNN blend, as in Python) */
  diffProbs(x, observed) {
    let p = this.rankedProbs(x, observed);
    const a = "knn_a" in this.cfg ? this.cfg.knn_a : 0.0;
    if (a > 0 && this.store.length) {
      const pk = this.knnProbs(x, observed, Math.trunc("knn_k" in this.cfg ? this.cfg.knn_k : 15));
      p = p.map(([i, v]) => [i, (1 - a) * v + a * pk[i]]);
    }
    return p;
  }
  /* Fitted._risk: (p, mass, p_lr, risk); mass sums in the dict order of p, like Python */
  _risk(x, observed) {
    const p = this.diffProbs(x, observed);
    const mass = pySum(p.filter(([i]) => this.isMal[i]).map(kv => kv[1]));
    const p_lr = this.lrPredict(x);
    return { p, mass, p_lr, risk: 0.5 * (p_lr + mass) };
  }
  lrPredict(x) {
    const F = this.FEATURES, vals = [];
    for (let fi = 0; fi < F.length; fi++) if (x[F[fi]]) vals.push(this.lr.beta[fi]);
    const z = this.lr.b0 + pySum(vals);
    return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
  }
  /* pipeline.red_flag_ablations: copies of x with every non-empty subset of its red flags switched off */
  redFlagAblations(x) {
    const present = this.redFlagFeatures.filter(f => x[f]);
    if (!present.length || present.length > this.guardFlagCap) return [];
    const out = [];
    for (let k = 1; k <= present.length; k++) {
      const idx = [];
      const rec = start => {
        if (idx.length === k) { const x2 = Object.assign({}, x); for (const i of idx) x2[present[i]] = 0; out.push(x2); return; }
        for (let i = start; i < present.length; i++) { idx.push(i); rec(i + 1); idx.pop(); }
      };
      rec(0);
    }
    return out;
  }
  /* Fitted.predict */
  predict(x, observed) {
    const r = this._risk(x, observed);
    let risk = r.risk;
    if (this.cfg.safety) {
      for (const x2 of this.redFlagAblations(x)) risk = Math.max(risk, this._risk(x2, observed).risk);
    }
    return { ranked: stableSort(r.p, kv => -kv[1]), p_nb: r.mass, p_lr: r.p_lr, risk };
  }
  /* knowledge.red_flag_score */
  redFlagScore(x) {
    const hits = this.K.RED_FLAGS.filter(t => x[t[0]]).map(t => ({ f: t[0], w: t[1], d: t[2], refs: t[3] }));
    if (x.surf_verrucous_papillary && x.col_white && (x.age_ge60 || x.age_40_59) && x.size_gt20) {
      const v = this.K.VERRUCOUS_RULE;
      hits.push({ f: v.flag, w: v.points, d: v.description, refs: v.refs });
    }
    return [pySum(hits.map(h => h.w)), hits];
  }
  tierOf(risk, rf) {
    const K = this.K;
    let tier = risk >= this.t_high ? "high" : risk >= this.t_int ? "intermediate" : risk >= this.t_watch ? "borderline" : "low";
    let override = null;
    if (rf >= K.RED_FLAG_STRONG && tier !== "high") { tier = "high"; override = "strong red flags"; }
    else if (rf >= K.RED_FLAG_THRESHOLD && K.TIER_ORDER.indexOf(tier) < 2) { tier = "intermediate"; override = "red flags"; }
    return [tier, override];
  }
  /* Oranosis.core: the validation code path. x: {feature: 0/1}, observed: Set */
  core(x, observed) {
    const p = this.predict(x, observed);
    const ranked = p.ranked.map(([i, pr]) => [this.classes[i], pr]);
    const [rf, hits] = this.redFlagScore(x);
    const [tier, override] = this.tierOf(p.risk, rf);
    let top = ranked.slice(0, 3).map(kv => kv[0]);
    let safety_inserted = null;
    if ((tier === "intermediate" || tier === "high") && !top.some(c => this.malig.has(c))) {
      const best = ranked.find(kv => this.malig.has(kv[0]))[0];
      top = top.slice(0, 2).concat([best]);
      safety_inserted = best;
    }
    return { ranked, top3: top, p_nb: p.p_nb, p_lr: p.p_lr, risk: p.risk, rf, hits, tier, override, safety_inserted,
             guard_raised: p.risk > 0.5 * (p.p_lr + p.p_nb) + 1e-12 };
  }
  /* DifferentialModel.explain (stage-1 Bayesian likelihood ratios) */
  explain(cls, x, observed, top = 6) {
    const F = this.FEATURES;
    if (!this._logT) {
      this._logT = this.classes.map(c => F.map(f => Math.log(this.nb.theta[c][f])));
      this._logSum = F.map((f, fi) => pySum(this._logT.map(row => row[fi])));
    }
    const nOthers = this.classes.length - 1, ci = this.classes.indexOf(cls);
    const pos = [], neg = [];
    for (let fi = 0; fi < F.length; fi++) {
      const f = F[fi], v = x[f];
      if (!v || !this.usable(fi, observed)) continue;
      const lt = this._logT[ci][fi];
      const lo = (this._logSum[fi] - lt) / nOthers;
      const d = lt - lo;
      if (v && d > 0.3) pos.push([f, d]);
      else if (v && d < -0.3) neg.push([f, d]);
    }
    return [stableSort(pos, t => -t[1]).slice(0, top), stableSort(neg, t => t[1]).slice(0, top)];
  }
  /* MalignancyModel.contributions */
  contributions(x, top = 8) {
    const c = [];
    this.FEATURES.forEach((f, fi) => { if (x[f] && Math.abs(this.lr.beta[fi]) > 0.05) c.push([f, this.lr.beta[fi]]); });
    return stableSort(c, t => -Math.abs(t[1])).slice(0, top);
  }
  extract(record) { return extract(record, this.K); }

  /* Oranosis.diagnose: same JSON shape and strings as the Python app output */
  diagnose(record, n = 5) {
    const K = this.K, e = this.extract(record), x = e.x, observed = e.observed;
    const r = this.core(x, observed);
    const probs = new Map(r.ranked);
    const diffs = [];
    const order = r.top3.concat(r.ranked.map(kv => kv[0]).filter(c => !r.top3.includes(c)));
    order.slice(0, n).forEach((c, i) => {
      const les = this.byId.get(c);
      const [pos, neg] = this.explain(c, x, observed);
      diffs.push({
        rank: i + 1, id: c, name: les.name, category: les.category, malignant: les.malignant,
        probability: pyRound(probs.get(c), 4), safety_inserted: c === r.safety_inserted,
        supporting: pos.map(t => K.LABELS[t[0]]), against: neg.map(t => K.LABELS[t[0]]),
        summary: les.key, discriminators: les.discriminators, references: les.refs.map(k => K.REFERENCES[k]),
      });
    });
    const warnings = [];
    if (e.missing_core.length) warnings.push("Missing core descriptors: " + e.missing_core.join(", ") + ".");
    if (e.completeness < 0.5) warnings.push("Very limited data: the differential is low-confidence.");
    const tier = r.tier;
    let advice = ADVICE[tier];
    // Fewer than half of the core descriptors: never seen in validation (all 255 cases had >= 3/6)
    if (e.completeness < 0.5) advice = "Unreliable: too little information. Complete the description. " + advice;
    return {
      version: K.version,
      differential: diffs,
      malignancy: {
        risk: pyRound(r.risk, 4), tier, tier_override: r.override,
        model_probability: pyRound(r.p_lr, 4), differential_malignant_mass: pyRound(r.p_nb, 4),
        monotone_guard_applied: r.guard_raised,
        red_flag_score: r.rf,
        red_flags: r.hits.map(h => ({ flag: h.d, points: h.w, references: h.refs.map(k => K.REFERENCES[k]) })),
        drivers: this.contributions(x).map(t => ({ feature: K.LABELS[t[0]], log_odds: pyRound(t[1], 2) })),
        advice,
        thresholds: { borderline: this.t_watch, intermediate: this.t_int, high: this.t_high },
      },
      recognized_features: this.FEATURES.filter(f => x[f]).map(f => K.LABELS[f]),
      completeness: pyRound(e.completeness, 2),
      warnings,
      disclaimer: DISCLAIMER,
      model_meta: this.meta,
    };
  }
  /* /api/info payload */
  info() {
    const K = this.K;
    return { version: K.version, meta: this.meta, lesions: K.LESIONS.map(l => ({
      id: l.id, name: l.name, category: l.category, malignant: l.malignant, summary: l.key,
      discriminators: l.discriminators, references: l.refs.map(k => K.REFERENCES[k]) })) };
  }
}

/** Python str(v) for the JSON value types that have an unambiguous JavaScript counterpart.
 *  Floats, lists and dicts are refused (TypeError) instead of being converted differently from Python:
 *  JavaScript cannot tell 5.0 from 5 after JSON.parse, and has no Python repr for containers. */
function pyStr(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number" && Number.isSafeInteger(v)) return String(v);
  throw new TypeError("unsupported field value: only text (and integers / booleans / null) are accepted");
}
/** server.py: the record is {str(k): ("" if v is None else str(v))[:MAX_FIELD]}; the UI and the CSV reader only produce strings. */
export function sanitizeRecord(rec, K) {
  const out = new Map();
  const entries = rec instanceof Map ? [...rec] : Array.isArray(rec) ? rec : Object.entries(rec);
  for (const [k, v] of entries) out.set(String(k), cpHead(pyStr(v), K.LIMITS.MAX_FIELD));
  return out;
}

/** Runtime self-test: the build embeds probe records with the answers of the Python reference (selftest.json). Returns the
 *  list of probes whose answer differs in this browser (empty = identical). Catches an engine bug, an old Unicode table or
 *  any other environment difference before a user relies on a result. */
export function selfTest(engine, probes) {
  const bad = [];
  for (const p of probes) {
    let got;
    try {
      const e = engine.extract(new Map(p.record));
      const d = engine.diagnose(new Map(p.record));
      got = { x: Object.keys(e.x).filter(f => e.x[f]), observed: [...e.observed].sort(), top: d.differential.map(t => t.id),
              risk: d.malignancy.risk, tier: d.malignancy.tier };
    } catch (err) { got = { error: String(err) }; }
    const w = p.expect;
    if (!got.x || got.x.join() !== w.x.join() || got.observed.join() !== w.observed.join() || got.top.join() !== w.top.join() ||
        got.risk !== w.risk || got.tier !== w.tier) bad.push(p.name);
  }
  return bad;
}

/* csv: Sniffer (csv.py), reader and writer (_csv.c) */
const PY_LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;      // str.splitlines()
const CSV_EXCEL = { delimiter: ",", quotechar: '"', doublequote: true, skipinitialspace: false };

function guessQuoteAndDelimiter(data, delimiters) {
  const body = q => `(?=((?:${q}{2}|(?!${q})[^])*))`;
  // [pattern, index of quote/delim/space among Python's findall tuple, group numbers in the JS pattern]
  const pats = [
    { re: PX(String.raw`([^\w\n"'])( ?)(["'])` + body("\\3") + String.raw`\4\3\1`, "gm"), q: 3, d: 1, s: 2 },
    { re: PX(String.raw`(?:^|\n)(["'])` + body("\\1") + String.raw`\2\1([^\w\n"'])( ?)`, "gm"), q: 1, d: 3, s: 4 },
    { re: PX(String.raw`([^\w\n"'])( ?)(["'])` + body("\\3") + String.raw`\4\3(?:$|\n)`, "gm"), q: 3, d: 1, s: 2 },
    { re: PX(String.raw`(?:^|\n)(["'])` + body("\\1") + String.raw`\2\1(?:$|\n)`, "gm"), q: 1, d: null, s: null },
  ];
  let matches = [], pat = null;
  for (const p of pats) {
    matches = [...data.matchAll(p.re)];
    if (matches.length) { pat = p; break; }
  }
  if (!matches.length) return ["", false, null, 0];
  const quotes = new Map(), delims = new Map();
  let spaces = 0;
  for (const m of matches) {
    const key = m[pat.q];
    if (key) quotes.set(key, (quotes.get(key) || 0) + 1);
    if (pat.d === null) continue;
    const dk = m[pat.d];
    if (dk && (delimiters === null || delimiters.includes(dk))) delims.set(dk, (delims.get(dk) || 0) + 1);
    if (m[pat.s]) spaces++;
  }
  const maxKey = mp => { let bk = null, bv = -1; for (const [k, v] of mp) if (v > bv) { bk = k; bv = v; } return bk; };
  const quotechar = maxKey(quotes);
  let delim, skipinitialspace;
  if (delims.size) {
    delim = maxKey(delims);
    skipinitialspace = delims.get(delim) === spaces;
    if (delim === "\n") delim = "";
  } else { delim = ""; skipinitialspace = 0; }
  let doublequote = false;
  if (delim) {
    const D = delim === "\t" ? "\\t" : delim, Q = quotechar;
    const dq = new RegExp(`(?:(?<=${D})|^) *${Q}(?=((?:${Q}${Q}|[^${Q}])*))\\1${Q}(?:${D}|$)`, "gmu");
    for (const m of data.matchAll(dq)) if (m[1].includes(Q + Q)) { doublequote = true; break; }
  }
  return [quotechar, doublequote, delim, skipinitialspace];
}

function guessDelimiter(data, delimiters) {
  const lines = data.split("\n").filter(Boolean);
  const chunkLength = Math.min(10, lines.length);
  let iteration = 0, numLines = 0;
  const charFrequency = new Map(), modes = new Map(), delims = new Map();
  let start = 0, end = chunkLength;
  const cnt = (s, sub) => s.split(sub).length - 1;
  while (start < lines.length) {
    iteration++;
    for (const line of lines.slice(start, end)) {
      numLines++;
      const c = new Map();
      for (const ch of line) c.set(ch, (c.get(ch) || 0) + 1);
      for (const [ch, count] of c) {
        if (ch.codePointAt(0) < 128) {
          if (!charFrequency.has(ch)) charFrequency.set(ch, new Map());
          const cf = charFrequency.get(ch);
          cf.set(count, (cf.get(count) || 0) + 1);
        }
      }
    }
    for (const [ch, counts] of charFrequency) {
      let items = [...counts];
      const missed = numLines - [...counts.values()].reduce((a, b) => a + b, 0);
      if (missed) items.push([0, missed]);
      if (items.length === 1 && items[0][0] === 0) continue;
      if (items.length > 1) {
        let mx = items[0];
        for (const it of items) if (it[1] > mx[1]) mx = it;
        items = items.filter(it => it !== mx);
        modes.set(ch, [mx[0], mx[1] - items.reduce((a, it) => a + it[1], 0)]);
      } else modes.set(ch, items[0]);
    }
    const total = Math.min(chunkLength * iteration, lines.length);
    let consistency = 1.0;
    const threshold = 0.9;
    while (delims.size === 0 && consistency >= threshold) {
      for (const [k, v] of modes) {
        if (v[0] > 0 && v[1] > 0 && (v[1] / total) >= consistency && (delimiters === null || delimiters.includes(k))) delims.set(k, v);
      }
      consistency -= 0.01;
    }
    if (delims.size === 1) {
      const delim = [...delims.keys()][0];
      return [delim, cnt(lines[0], delim) === cnt(lines[0], delim + " ")];
    }
    start = end; end += chunkLength;
  }
  if (!delims.size) return ["", 0];
  if (delims.size > 1) {
    for (const d of [",", "\t", ";", " ", ":"]) {
      if (delims.has(d)) return [d, cnt(lines[0], d) === cnt(lines[0], d + " ")];
    }
  }
  const items = [...delims].map(([k, v]) => [v, k]);
  items.sort((a, b) => (a[0][0] - b[0][0]) || (a[0][1] - b[0][1]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const delim = items[items.length - 1][1];
  return [delim, cnt(lines[0], delim) === cnt(lines[0], delim + " ")];
}

/** csv.Sniffer().sniff(sample, delimiters=",;\t"); returns a dialect or throws like csv.Error */
export function csvSniff(sample, delimiters = ",;\t") {
  sample = sample.split("\r\n").join("\n").split("\r").join("\n");
  let [quotechar, doublequote, delimiter, skipinitialspace] = guessQuoteAndDelimiter(sample, delimiters);
  if (!delimiter) [delimiter, skipinitialspace] = guessDelimiter(sample, delimiters);
  if (!delimiter) throw new Error("Could not determine delimiter");
  return { delimiter, quotechar: quotechar || '"', doublequote, skipinitialspace: !!skipinitialspace };
}

/** csv.reader over io.StringIO(text): generator of records (arrays of strings); throws like csv.Error */
function* csvRecords(text, dia) {
  const START_RECORD = 0, START_FIELD = 1, IN_FIELD = 3, IN_QUOTED_FIELD = 4, QUOTE_IN_QUOTED_FIELD = 6, EAT_CRNL = 7, EOL = -2;
  const { delimiter, quotechar, doublequote, skipinitialspace } = dia;
  let state, fields, field;
  const save = () => { fields.push(field); field = ""; };
  const proc = c => {                  // c: one character or EOL
    switch (state) {
      case START_RECORD:
        if (c === EOL) break;
        if (c === "\n" || c === "\r") { state = EAT_CRNL; break; }
        state = START_FIELD;
        /* falls through */
      case START_FIELD:
        if (c === "\n" || c === "\r" || c === EOL) { save(); state = c === EOL ? START_RECORD : EAT_CRNL; }
        else if (c === quotechar) state = IN_QUOTED_FIELD;
        else if (c === " " && skipinitialspace) { /* ignore spaces at start of field */ }
        else if (c === delimiter) save();
        else { field += c; state = IN_FIELD; }
        break;
      case IN_FIELD:
        if (c === "\n" || c === "\r" || c === EOL) { save(); state = c === EOL ? START_RECORD : EAT_CRNL; }
        else if (c === delimiter) { save(); state = START_FIELD; }
        else field += c;
        break;
      case IN_QUOTED_FIELD:
        if (c === EOL) { /* keep reading */ }
        else if (c === quotechar) state = doublequote ? QUOTE_IN_QUOTED_FIELD : IN_FIELD;
        else field += c;
        break;
      case QUOTE_IN_QUOTED_FIELD:
        if (c === quotechar) { field += c; state = IN_QUOTED_FIELD; }
        else if (c === delimiter) { save(); state = START_FIELD; }
        else if (c === "\n" || c === "\r" || c === EOL) { save(); state = c === EOL ? START_RECORD : EAT_CRNL; }
        else { field += c; state = IN_FIELD; }
        break;
      case EAT_CRNL:
        if (c === "\n" || c === "\r") { /* eat */ }
        else if (c === EOL) state = START_RECORD;
        else throw new Error("new-line character seen in unquoted field - do you need to open the file with newline=''?");
        break;
      default: throw new Error("bad state");
    }
  };
  let pos = 0;
  const n = text.length;
  while (pos < n) {
    state = START_RECORD; fields = []; field = "";
    do {
      if (pos >= n) {                 // end of input inside a record
        if (field.length !== 0 || state === IN_QUOTED_FIELD) { save(); break; }
        return;
      }
      let nl = text.indexOf("\n", pos);
      const lineEnd = nl === -1 ? n : nl + 1;
      for (let i = pos; i < lineEnd; i++) proc(text[i]);
      pos = lineEnd;
      proc(EOL);
    } while (state !== START_RECORD);
    yield fields;
  }
}

/** csv.writer(dialect=excel).writerow for string fields */
function csvWriteRow(fields) {
  let rec = "";
  fields.forEach((f, i) => {
    if (i > 0) rec += ",";
    let q = false, s = "";
    for (const c of f) {
      if (c === "," || c === '"' || c === "\r" || c === "\n") { q = true; if (c === '"') s += '"'; }
      s += c;
    }
    rec += q ? '"' + s + '"' : s;
  });
  if (fields.length > 0 && rec.length === 0) rec = '""';
  return rec + "\r\n";
}

/** Neutralise spreadsheet formulas (CSV injection) in cells we write back (server._safe_cell). */
export function safeCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  const c0 = s.slice(0, 1);
  const second = s.length > 1 ? String.fromCodePoint(s.codePointAt(1)) : "";
  return (c0 === "=" || c0 === "+" || c0 === "@" || c0 === "\t" || c0 === "\r" ||
    (c0 === "-" && s.length > 1 && !pyIsDigit(second) && second !== " ")) ? "'" + s : s;
}

/** server.batch_csv: CSV text (thesis format, <= MAX_ROWS rows) -> CSV text with the Oranosis columns.
 *  opts.onProgress(done) and opts.yieldEvery let a UI stay responsive; the result is identical. */
export async function batchCsv(engine, text, opts = {}) {
  const K = engine.K, { MAX_ROWS, MAX_FIELD } = K.LIMITS, FIELDS = K.BATCH_FIELDS;
  text = text.replace(/^\ufeff+/, "");
  if (!pyStrip(text)) throw new Error("the file is empty");
  const head = pyStrip(text) ? cpHead(text, 4096).split(PY_LINE_BREAK)[0] : "";
  let dialect;
  try { dialect = csvSniff(head, ",;\t"); } catch (e) { dialect = CSV_EXCEL; }
  const it = csvRecords(text, dialect);
  const first = it.next();
  const names = first.done ? [] : first.value;
  const fieldnames = first.done ? null : names;
  const known = new Set(names.map(normKey).filter(k => FIELDS.includes(k)));
  if (!known.size) throw new Error("no recognised column. The first row must be a header with the thesis field names, e.g. " +
    FIELDS.join(", ") + " (see the template on the Batch tab)");
  const fields = names.concat(["Oranosis Dx", "Malignancy risk", "Risk tier", "Red-flag score", "Warnings"]);
  let out = csvWriteRow(fields);
  let i = 0;
  const yieldEvery = opts.yieldEvery || 0;
  for (;;) {
    let row;                                                     // DictReader.__next__
    do { const nx = it.next(); if (nx.done) { row = null; break; } row = nx.value; } while (row.length === 0);
    if (row === null) break;
    if (i >= MAX_ROWS) throw new Error(`batch limited to ${MAX_ROWS} rows`);
    const d = new Map();
    const lf = fieldnames.length, lr = row.length;
    for (let j = 0; j < Math.min(lf, lr); j++) d.set(fieldnames[j], row[j]);
    if (lf > lr) for (const key of fieldnames.slice(lr)) d.set(key, "");
    d.delete("_extra");                                          // ragged cells (restkey) are ignored
    const rec = new Map();
    for (const [k, v] of d) rec.set(k, cpHead(v === null || v === undefined ? "" : String(v), MAX_FIELD));
    const res = engine.diagnose(rec);
    const dd = res.differential.slice(0, 3);
    const outRow = new Map();
    for (const [k, v] of rec) outRow.set(k, safeCell(v));
    outRow.set("Oranosis Dx", dd.map(x => `${x.rank}. ${x.name} (${pyFixed(100 * x.probability, 0)}%)`).join("; "));
    outRow.set("Malignancy risk", `${pyFixed(100 * res.malignancy.risk, 1)}%`);
    outRow.set("Risk tier", res.malignancy.tier.toUpperCase());
    outRow.set("Red-flag score", res.malignancy.red_flags.length ? pyFloatStr(res.malignancy.red_flag_score) : "0");
    outRow.set("Warnings", res.warnings.join(" | "));
    out += csvWriteRow(fields.map(k => mapGet(outRow, k, "")));
    i++;
    if (opts.onProgress) opts.onProgress(i);
    if (yieldEvery && i % yieldEvery === 0) await new Promise(r => setTimeout(r, 0));
  }
  return out;
}
