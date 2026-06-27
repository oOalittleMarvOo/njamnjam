/* =================================================================
   openfoodfacts.js  –  Anbindung für die Tagesbilanz-App
   -----------------------------------------------------------------
   Holt Lebensmittel von Open Food Facts (kostenlos, kein API-Key)
   und mappt sie auf das Schema deiner App:
     { id, n, cat, g, kcal, p, f, mg, ca, na, k }   (Minerale in mg)

   LÄUFT NICHT im Claude-Artifact-Sandbox (fremde Domain geblockt),
   sondern in deinem eigenen React-Projekt (Vite/Next/CRA o.ä.).
   ================================================================= */

const OFF_BASE = "https://world.openfoodfacts.org";

/* -----------------------------------------------------------------
   STOLPERFALLE 1 – Einheiten:
   Open Food Facts speichert Mineralien in GRAMM pro 100 g.
   magnesium_100g = 0.35  bedeutet 350 mg.  → ×1000 für mg.

   STOLPERFALLE 2 – Natrium vs. Salz:
   Manche Produkte liefern sodium_100g, andere nur salt_100g.
   Salz = Natrium × 2,5  →  Natrium = Salz ÷ 2,5.
   Wir bevorzugen sodium_100g und rechnen sonst aus salt_100g.

   STOLPERFALLE 3 – Kalorien:
   energy-kcal_100g ist das, was du willst. energy_100g ist kJ.
   Fallback: kJ ÷ 4,184.

   STOLPERFALLE 4 – User-Agent:
   OFF bittet um einen eigenen User-Agent. Browser dürfen den
   Header aber nicht setzen (verbotener Header) → einfach weglassen,
   funktioniert trotzdem. Auf dem Server kannst du ihn setzen.
   ----------------------------------------------------------------- */

// Sicheres Auslesen + Umrechnen einer Mineral-Angabe (g → mg)
const mgFrom = (grams) =>
  grams === undefined || grams === null || grams === "" ? null : Math.round(Number(grams) * 1000);

const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));

// Rohes OFF-Produkt → unser App-Schema
export function mapProduct(product) {
  const nu = product.nutriments || {};

  // Kalorien: kcal bevorzugt, sonst aus kJ
  let kcal = num(nu["energy-kcal_100g"]);
  if (kcal === null && num(nu["energy_100g"]) !== null) {
    kcal = Math.round(num(nu["energy_100g"]) / 4.184);
  }

  // Natrium: sodium bevorzugt, sonst aus Salz zurückrechnen
  let na = mgFrom(nu["sodium_100g"]);
  if (na === null && nu["salt_100g"] !== undefined) {
    na = Math.round((Number(nu["salt_100g"]) / 2.5) * 1000);
  }

  // typische Portion, falls vorhanden (sonst 100 g)
  const portion = num(product.serving_quantity);

  return {
    id: "off_" + (product.code || Math.random().toString(36).slice(2)),
    n: product.product_name?.trim() || product.generic_name?.trim() || "Unbenannt",
    brand: product.brands || "",
    cat: "Open Food Facts",
    g: portion && portion > 0 ? Math.round(portion) : 100,
    kcal: kcal ?? 0,
    p: num(nu["proteins_100g"]) ?? 0,
    f: num(nu["fat_100g"]) ?? 0,
    mg: mgFrom(nu["magnesium_100g"]) ?? 0,
    ca: mgFrom(nu["calcium_100g"]) ?? 0,
    na: na ?? 0,
    k: mgFrom(nu["potassium_100g"]) ?? 0,
    // Hinweis, falls Mineralwerte fehlen (OFF ist crowdsourced!)
    incomplete:
      mgFrom(nu["magnesium_100g"]) === null ||
      mgFrom(nu["calcium_100g"]) === null ||
      mgFrom(nu["potassium_100g"]) === null,
  };
}

// Nur die Felder anfordern, die wir brauchen → schnellere Antworten
const FIELDS = [
  "code", "product_name", "generic_name", "brands", "serving_quantity",
  "nutriments",
].join(",");

/* -----------------------------------------------------------------
   Suche per Name. Gibt eine Liste gemappter Lebensmittel zurück.
   ----------------------------------------------------------------- */
export async function searchFoods(term, { limit = 12, lang = "de" } = {}) {
  const url =
    `${OFF_BASE}/cgi/search.pl?search_terms=${encodeURIComponent(term)}` +
    `&search_simple=1&action=process&json=1&page_size=${limit}` +
    `&lc=${lang}&fields=${FIELDS}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`OFF-Suche fehlgeschlagen (${res.status})`);
  const data = await res.json();

  return (data.products || [])
    .map(mapProduct)
    .filter((f) => f.n !== "Unbenannt"); // Müll rausfiltern
}

/* -----------------------------------------------------------------
   Abruf per Barcode (z. B. aus einem Scanner). v2-Endpoint.
   ----------------------------------------------------------------- */
export async function getByBarcode(code) {
  const url = `${OFF_BASE}/api/v2/product/${encodeURIComponent(code)}.json?fields=${FIELDS}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Produkt nicht gefunden (${res.status})`);
  const data = await res.json();
  if (data.status !== 1 || !data.product) throw new Error("Barcode nicht in der Datenbank");
  return mapProduct(data.product);
}


/* =================================================================
   BEISPIEL-INTEGRATION in die Tagesbilanz-App
   -----------------------------------------------------------------
   Ersetzt bei dir den Claude-Lookup. Gleiche Idee: Treffer landet
   in extraFoods + wird dem Tag hinzugefügt.
   ================================================================= */

import React, { useState } from "react";

export function FoodSearch({ onPick }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  async function run() {
    const q = query.trim();
    if (!q || loading) return;
    setLoading(true); setErr(""); setResults([]);
    try {
      const list = await searchFoods(q, { limit: 12 });
      if (list.length === 0) setErr("Nichts gefunden. Anders formulieren?");
      setResults(list);
    } catch (e) {
      setErr(e.message || "Suche fehlgeschlagen.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 7 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          placeholder="z. B. Skyr Natur, Falafel, Vollkornbrot…"
          disabled={loading}
        />
        <button onClick={run} disabled={loading || !query.trim()}>
          {loading ? "…" : "Suchen"}
        </button>
      </div>

      {err && <p style={{ color: "#D6453B", fontSize: 12 }}>{err}</p>}

      {results.map((f) => (
        <button
          key={f.id}
          onClick={() => onPick(f)}            // f hat exakt dein App-Schema
          style={{ display: "block", width: "100%", textAlign: "left", margin: "6px 0" }}
        >
          <strong>{f.n}</strong> {f.brand && <span>· {f.brand}</span>}
          <br />
          <small>
            {f.g} g · {f.kcal} kcal · Mg {f.mg} · Ca {f.ca} · Na {f.na} · K {f.k}
            {f.incomplete && "  ⚠️ Mineralwerte unvollständig"}
          </small>
        </button>
      ))}
    </div>
  );
}

/*  In deiner Hauptkomponente dann:

    <FoodSearch onPick={(food) => {
      setExtraFoods((p) => [...p, food]);
      setItems((p) => [...p, { key: crypto.randomUUID(), id: food.id, grams: food.g }]);
    }} />

    Der Rest deiner Tagesbilanz-Logik (resolve, totals, Element-Chips,
    Na:K-Waage) bleibt unverändert – food passt schon ins Schema.
*/
