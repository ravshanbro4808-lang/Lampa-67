import express from "express";

const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(express.static("public"));

const SYSTEM = `Sen sabrli va quvnoq shaxsiy ustozsan. Foydalanuvchi mavzu yozadi yoki masala/kitob sahifasining rasmini yuboradi.
Mavzuni 5-7 qadamda, oddiy oʻzbek tilida (lotin yozuvi) tushuntir. Har qadamda:
- say: ovoz chiqarib aytiladigan 1-2 qisqa gap;
- write: doskaga yoziladigan juda qisqa yozuv (3-8 soʻz yoki formula);
- shape: none, circle, arrow, box yoki underline (yozuvni taʼkidlash uchun).
Eng oddiy gapdan boshla, hayotiy misol keltir. Rasmda masala boʻlsa, yechimni qadamma-qadam ber.
Oxirida check: tushunganini tekshiradigan bitta savol.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    steps: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          say: { type: "STRING" },
          write: { type: "STRING" },
          shape: { type: "STRING", enum: ["none", "circle", "arrow", "box", "underline"] },
        },
        required: ["say", "write", "shape"],
      },
    },
    check: { type: "STRING" },
  },
  required: ["title", "steps", "check"],
};

app.get("/api/models", async (req, res) => {
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": KEY } });
    const d = await r.json();
    if (!r.ok) return res.status(500).json({ error: d?.error?.message });
    res.json((d.models || []).filter(m => m.supportedGenerationMethods?.includes("generateContent")).map(m => m.name.replace("models/", "")));
  } catch (e) { res.status(500).json({ error: String(e.message) }); }
});

app.post("/api/lesson", async (req, res) => {
  try {
    if (!KEY) return res.status(500).json({ error: "GEMINI_API_KEY oʻrnatilmagan." });
    const topic = String(req.body.topic || "").slice(0, 1000);
    const images = Array.isArray(req.body.images) ? req.body.images.slice(0, 100) : [];
    if (images.reduce((a, x) => a + String(x).length, 0) > 19e6)
      return res.status(413).json({ error: "Rasmlar juda koʻp yoki katta. Bir qismini olib tashlab, qayta yuboring." });
    const parts = [{ text: topic || "Rasmlardagi mavzuni tushuntir. Bir nechta rasm boʻlsa, hammasini bitta dars qilib birlashtir." }];
    for (const img of images) {
      const m = String(img).match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
      if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
    }
    if (!topic && parts.length === 1) return res.status(400).json({ error: "Mavzu yozing yoki rasm yuboring." });

    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0.7 },
    });
    const models = [MODEL, process.env.GEMINI_FALLBACK_MODEL].filter(Boolean);
    let data, r;
    for (let attempt = 0; attempt < 4; attempt++) {
      const model = models[attempt % models.length];
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
        body,
      });
      data = await r.json();
      if (r.ok) break;
      if (![429, 500, 503].includes(r.status)) break;
      await new Promise(ok => setTimeout(ok, 1500 * (attempt + 1)));
    }
    if (!r.ok) {
      if ([429, 503].includes(r.status))
        return res.status(503).json({ error: "Hozir band, juda koʻp soʻrov bor. Bir daqiqadan keyin qayta urinib koʻring. (" + r.status + ": " + String(data?.error?.message || "").slice(0, 200) + ")" });
      throw new Error(data?.error?.message || "Gemini xatosi");
    }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    res.json(JSON.parse(text));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Dars yaratib boʻlmadi: " + String(e.message).slice(0, 300) });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Lampa ishga tushdi"));
