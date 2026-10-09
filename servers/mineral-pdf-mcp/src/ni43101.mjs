// Heuristic NI 43-101 Mineral Resource parser.
// Works on the extracted text lines of a technical report: reads resource
// tables (category rows) and narrative statements ("Total Measured and
// Indicated ... are X Mt at Y% containing Z kt").

const NUM = String.raw`([\d,]+(?:\.\d+)?)`;

const CATEGORIES = ["Measured", "Indicated", "Inferred"];

function num(s) {
  if (s == null) return null;
  const n = Number(String(s).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function parseSegment(text) {
  const tonnage_m_t = (() => {
    const m = text.match(new RegExp(`${NUM}\\s*(?:Mt|million\\s+tonnes?|Mt\\s*of)`, "i"));
    return m ? num(m[1]) : null;
  })();
  const grade_pct = (() => {
    const m = text.match(new RegExp(`${NUM}\\s*%\\s*(?:Li2O|Li\\s*2\\s*O|Sc\\s*2\\s*O\\s*3|TCN|Fe|Cu|Ni|Zn|Pb|Au|Sb|grade)?`, "i"));
    return m ? num(m[1]) : null;
  })();
  const contained_metal_kt_lce = (() => {
    const m = text.match(new RegExp(`${NUM}\\s*(kt|kilotonne(?:s)?)\\s*(LCE|Li2O|contained|metal)?`, "i"));
    if (!m) return null;
    const v = num(m[1]);
    return /kt/i.test(m[2]) ? v : v;
  })();
  const contained_metal_t = (() => {
    const m = text.match(new RegExp(`${NUM}\\s*(tonnes?|t)\\b(?!\\s*(?:\\/|of\\s+(?:Li|Fe)))`, "i"));
    return m ? num(m[1]) : null;
  })();
  return { tonnage_m_t, grade_pct, contained_metal_kt_lce, contained_metal_t };
}

function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v != null && out[k] == null) out[k] = v;
  }
  return out;
}

function findEffectiveDate(text) {
  const m =
    text.match(/effective\s+date[:\s]+(\d{1,2}\s+[A-Z][a-z]+\s+\d{4})/i) ??
    text.match(/effective\s+date[:\s]+(\d{4}-\d{2}-\d{2})/i) ??
    text.match(/dated[:\s]+(\d{1,2}\s+[A-Z][a-z]+\s+\d{4})/i);
  return m ? m[1] : null;
}

function findQualifiedPerson(text) {
  const m =
    text.match(/Prepared\s+by[:\s]+([A-Z][A-Za-z'\-\. ]{2,40}?,\s*[A-Z]\.[A-Za-z]{2,6}\.)/i) ??
    text.match(/Qualified\s+Person[:\s]+([A-Z][A-Za-z'\-\. ]{2,40}?,\s*[A-Z]\.[A-Za-z]{2,6}\.)/i) ??
    text.match(/Prepared\s+by[:\s]+([^\n.]{3,120})/i);
  return m ? m[1].replace(/\s+/g, " ").trim().slice(0, 140) : null;
}

function findProject(text) {
  const m =
    text.match(/Project[:\s]+([^\n]{5,120})/i) ??
    text.match(/(?:Technical\s+Report|Summary)\s+(?:on|for)\s+([^\n]{5,120})/i);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

const COMMODITY_HINTS = [
  ["lithium", /lithium|Li2O|spodumene|lepidolite/i],
  ["tantalum", /tantalite|tantalum|coltan/i],
  ["rare earths", /rare earth|REO\b|neodymium|praseodymium/i],
  ["nickel", /nickel|laterite/i],
  ["copper", /copper|chalcopyrite/i],
  ["iron ore", /iron ore|hematite|magnetite/i],
  ["gold", /\bgold\b|auriferous/i],
];

function findCommodity(text) {
  return COMMODITY_HINTS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

function sentencesMatching(text, re, limit = 4) {
  return text
    .split(/(?<=[.;])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 25 && re.test(s))
    .slice(0, limit);
}

// PDFs hard-wrap lines, so re-join prose before matching multi-line statements.
function softWrap(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .reduce((acc, line) => {
      if (!acc.length) return [line];
      const prev = acc[acc.length - 1];
      // Merge only when the break is clearly mid-sentence: dangling comma/hyphen,
      // or the continuation starts with a lowercase word.
      const dangling = /[,;(\-]$/.test(prev) || /and$/i.test(prev.split(" ").slice(-1)[0]);
      const lowerContinuation = /\w$/.test(prev) && /^[a-z]/.test(line);
      if (dangling || lowerContinuation) {
        acc[acc.length - 1] = `${prev} ${line}`;
      } else {
        acc.push(line);
      }
      return acc;
    }, [])
    .join("\n");
}

export function parseNi43101(lines, text) {
  const wrapped = softWrap(text);
  const joined = wrapped.replace(/\s*\n\s*/g, " ");

  // --- 1. table rows: a category keyword followed by numbers on the same line
  const resources = {};
  const rowHits = {};
  let currentCat = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line) continue;
    // "Total Measured and Indicated ..." is a combined figure, not a category row.
    if (/^total\b/i.test(line)) continue;
    const catAt = CATEGORIES.map((c) => ({ c, at: line.toLowerCase().indexOf(c.toLowerCase()) })).filter(
      (x) => x.at >= 0
    );
    const startsWithNumber = new RegExp(`^${NUM}`).test(line);
    if (catAt.length) {
      // A line may carry several categories; each one owns the text up to the next.
      for (let i = 0; i < catAt.length; i++) {
        const { c: cat, at } = catAt[i];
        const nextAt = catAt[i + 1]?.at ?? line.length;
        const after = line.slice(at + cat.length, nextAt);
        const parsed = parseSegment(after);
        if (parsed.tonnage_m_t != null || parsed.grade_pct != null) {
          resources[cat] = merge(resources[cat] ?? {}, parsed);
          rowHits[cat] = (rowHits[cat] ?? 0) + 1;
          currentCat = cat;
        }
      }
    } else if (currentCat && startsWithNumber && resources[currentCat]) {
      // continuation row (table wrapped onto the next line)
      resources[currentCat] = merge(resources[currentCat], parseSegment(line));
    }
  }

  // --- 2. narrative statements: "Inferred Mineral Resources are 74.9 Mt at 1.16% Li2O, containing 702 kt"
  // and combined "Total Measured and Indicated Mineral Resources are 151.0 Mt at 1.22% ... 1,667 kt".
  const totals = {};
  const statements = [];
  const catAlt = CATEGORIES.join("|");
  const singleRe = new RegExp(
    `\\b(${catAlt})\\b((?!\\b(?:${catAlt})\\b)[^.\\n]){0,60}?${NUM}\\s*Mt[^.\\n]{0,40}?${NUM}\\s*%[^.\\n]{0,60}?${NUM}\\s*kt`,
    "gi"
  );
  for (const m of joined.matchAll(singleRe)) {
    statements.push({
      cat: m[1],
      value: { tonnage_m_t: num(m[3]), grade_pct: num(m[4]), contained_metal_kt_lce: num(m[5]) },
      raw: m[0],
    });
  }
  const combinedRe = new RegExp(
    `\\bTotal\\s+(${catAlt})(?:\\s+and\\s+(${catAlt}))?[^.\\n]{0,160}?${NUM}\\s*Mt[^.\\n]{0,40}?${NUM}\\s*%[^.\\n]{0,60}?${NUM}\\s*kt`,
    "gi"
  );
  for (const m of joined.matchAll(combinedRe)) {
    const key = [m[1], m[2]].filter(Boolean).join(" and ");
    const value = { tonnage_m_t: num(m[3]), grade_pct: num(m[4]), contained_metal_kt_lce: num(m[5]) };
    totals[key] = value;
    statements.push({ cat: key, value, raw: m[0], combined: true });
  }

  // --- 3. fill any missing category from the narrative statements
  for (const cat of CATEGORIES) {
    if (resources[cat]?.tonnage_m_t != null) continue;
    const hit = statements.find((s) => s.cat === cat && !s.combined);
    if (hit) resources[cat] = merge(resources[cat] ?? {}, hit.value);
  }

  const miKey = Object.keys(totals).find((k) => /Measured/i.test(k) && /Indicated/i.test(k));
  const inferredTotal = totals.Inferred;
  if (!resources.Measured?.tonnage_m_t && !resources.Indicated?.tonnage_m_t && miKey) {
    resources.Indicated = merge(resources.Indicated ?? {}, {
      ...totals[miKey],
      note: "reported as combined Measured and Indicated",
    });
  }
  if (!resources.Inferred?.tonnage_m_t && inferredTotal) {
    resources.Inferred = merge(resources.Inferred ?? {}, inferredTotal);
  }

  const clean = {};
  for (const cat of CATEGORIES) {
    if (resources[cat]) clean[cat] = { ...resources[cat] };
  }
  const present = CATEGORIES.filter((c) => clean[c]?.tonnage_m_t != null);
  const totalTonnage = present.reduce((s, c) => s + clean[c].tonnage_m_t, 0) || null;
  const totalContained = present.reduce(
    (s, c) => s + (clean[c].contained_metal_kt_lce ?? 0),
    0
  );

  // --- 4. confidence + risk flags
  const flags = [];
  const ind = clean.Indicated?.tonnage_m_t ?? 0;
  const inf = clean.Inferred?.tonnage_m_t ?? 0;
  const inferredShare = totalTonnage ? inf / totalTonnage : null;

  if (!present.length) {
    flags.push({
      level: "high",
      flag: "No NI 43-101 resource table could be parsed from this document.",
    });
  }
  if (ind === 0 && inf > 0) {
    flags.push({ level: "high", flag: "Only Inferred resources reported — no Indicated/Measured tonnage." });
  }
  if (inferredShare != null && inferredShare > 0.4) {
    flags.push({
      level: "medium",
      flag: `Inferred resources are ${(inferredShare * 100).toFixed(0)}% of total tonnage (NI 43-101: Inferred tonnage/grade cannot be used for feasibility or production decisions).`,
    });
  }
  const uncertainQuotes = sentencesMatching(
    wrapped,
    /too uncertain|not have economic|cannot be|solely on Inferred|Inferred.*excluded|no assurance/i
  );
  for (const q of uncertainQuotes.slice(0, 2)) {
    flags.push({ level: "medium", flag: "Qualified-person caution", quote: q });
  }
  const permittingQuotes = sentencesMatching(
    wrapped,
    /permit|approval|lease|Native Title|outstanding|cost overrun|risk of|delay/i
  );
  for (const q of permittingQuotes.slice(0, 3)) {
    flags.push({ level: "low", flag: "Permitting / schedule / cost risk mentioned", quote: q });
  }
  const study = (
    wrapped.match(
      /(scoping study|preliminary economic assessment|\bPEA\b|prefeasibility|pre-feasibility|bankable feasibility|feasibility study)/i
    ) ?? []
  )[0];

  const confidence =
    present.length >= 2 && ind > 0 && clean.Indicated?.contained_metal_kt_lce != null
      ? "high"
      : present.length >= 1 && ind > 0
        ? "moderate"
        : present.length
          ? "low"
          : "none";

  return {
    report: {
      project: findProject(wrapped),
      effective_date: findEffectiveDate(wrapped),
      qualified_person: findQualifiedPerson(wrapped),
      commodity: findCommodity(wrapped),
      study_stage: study ?? null,
      ni_43_101_reference: /\bNI\s*43-?101\b/i.test(text),
    },
    resources: clean,
    totals: {
      measured_plus_indicated: totals[miKey] ?? null,
      inferred: totals.Inferred ?? null,
      parsed_tonnage_m_t: totalTonnage,
      parsed_contained_kt_lce: totalContained || null,
      inferred_share_of_tonnage: inferredShare != null ? Number(inferredShare.toFixed(3)) : null,
    },
    confidence: {
      level: confidence,
      parsed_categories: present,
      source_form: Object.keys(rowHits).length ? "table_rows" : "narrative",
    },
    risk_flags: flags,
  };
}
