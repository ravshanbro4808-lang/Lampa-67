import express from "express";

const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const TTS_MODELS = (process.env.GEMINI_TTS_MODELS || "gemini-3.8-flash-lite-tts,gemini-3.8-flash-tts").split(",").map(x => x.trim());
const API = "https://generativelanguage.googleapis.com/v1beta";
const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(express.static("public"));

const SYSTEM = `Sen sabrli, iliq va xushmuomala oʻzbek ustozisan. Foydalanuvchi mavzu yozadi yoki masala yoki kitob sahifasining rasmlarini yuboradi (rasm koʻp boʻlsa, hammasini bitta dars qilib birlashtir).
Mavzuni 5-7 qadamda tushuntir. Har qadamda:
- say: ovoz chiqarib aytiladigan 2-3 gap. Sof, adabiy va jonli oʻzbek tilida (lotin yozuvi) gapir, xuddi tajribali oʻzbek oʻqituvchisidek. Ruscha va inglizcha soʻzlarni ishlatma; oʻzbekcha muqobili boʻlsa, shuni ayt. Faqat oʻzbekchasi umuman yoʻq ilmiy atamalarni qoldir. say ovozda oʻqiladi, shuning uchun raqam va formulalarni soʻz bilan yoz (masalan "a kvadrat", "uch ga toʻrt").
- points: doskaga yoziladigan 1-3 ta qisqa band. Har biri 3-9 soʻz, oxirida nuqta. Formula yoki asosiy fikrni yoz.
- svg: shu qadamga mos oddiy chizma, <svg> tegisiz faqat ichki qismi. Faqat line, path, circle, ellipse, rect, polygon, polyline, text teglari. Hamma narsa viewBox 0 0 300 180 ichida boʻlsin. fill, stroke, style, class yozma. Muhim joyni qizil qilish uchun data-c="r", koʻk uchun data-c="b" ber. text uchun x, y, text-anchor ber, matn 1-3 soʻz boʻlsin. Chizmani mantiqiy tartibda yoz: avval asosiy shakl, keyin belgilar. Chizma mumkin boʻlmasa, boʻsh qator qaytar.
Eng oddiy gapdan boshla, hayotiy misol keltir. Rasmda masala boʻlsa, yechimni qadamma-qadam ber.
title ham, check ham oʻzbek tilida. check: tushunganini tekshiradigan bitta savol.`;

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
          points: { type: "ARRAY", items: { type: "STRING" } },
          svg: { type: "STRING" },
        },
        required: ["say", "points", "svg"],
      },
    },
    check: { type: "STRING" },
  },
  required: ["title", "steps", "check"],
};

app.get("/api/models", async (req, res) => {
  try {
    const r = await fetch(`${API}/models?pageSize=200`, { headers: { "x-goog-api-key": KEY } });
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
    const models = (process.env.GEMINI_MODELS || [MODEL, process.env.GEMINI_FALLBACK_MODEL].filter(Boolean).join(","))
      .split(",").map(x => x.trim()).filter(Boolean);
    let data, r;
    for (let attempt = 0; attempt < Math.min(6, Math.max(4, models.length * 2)); attempt++) {
      const model = models[attempt % models.length];
      try {
        r = await fetch(`${API}/models/${model}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
          body,
          signal: AbortSignal.timeout(40000),
        });
        data = await r.json();
      } catch (err) {
        r = { ok: false, status: 503 };
        data = { error: { message: "Javob kechikdi (" + model + ")" } };
      }
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

/* ---------- ovoz (Gemini TTS, oʻzbek tili) ---------- */
let uzVoice;
async function pickVoice() {
  if (process.env.GEMINI_VOICE) return process.env.GEMINI_VOICE;
  if (uzVoice) return uzVoice;
  try {
    const r = await fetch(`${API}/voices?language_code=uz-UZ&type=prebuilt&page_size=5`, { headers: { "x-goog-api-key": KEY } });
    const d = await r.json();
    uzVoice = d.voices?.[0]?.id || "Kore";
  } catch { uzVoice = "Kore"; }
  console.log("Ovoz:", uzVoice);
  return uzVoice;
}
async function tts(text, model, voice) {
  const r = await fetch(`${API}/interactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
      model,
      input: [{ type: "user_input", content: [{ type: "text", text,
        annotations: [{ type: "speech_metadata", style: "calm, warm and clear teacher; natural fluent spoken Uzbek, pure native pronunciation" }] }] }],
      response_format: { type: "audio" },
      generation_config: { speech_config: [{ voice }] },
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.message || "TTS xatosi");
  const a = (d.steps || []).flatMap(s => s.content || []).filter(c => c.type === "audio").pop();
  if (!a?.data) throw new Error("Audio kelmadi");
  return { audio: a.data, mime: a.mime_type || "audio/wav" };
}
const ttsCache = new Map();
app.post("/api/tts", async (req, res) => {
  const text = String(req.body.text || "").slice(0, 700);
  if (!text) return res.status(400).json({ error: "Matn yoʻq" });
  if (ttsCache.has(text)) return res.json(ttsCache.get(text));
  const voice = await pickVoice();
  const tries = [[TTS_MODELS[0], voice], [TTS_MODELS[0], "Kore"], [TTS_MODELS[1] || TTS_MODELS[0], "Kore"]];
  for (const [model, v] of tries) {
    try {
      const out = await tts(text, model, v);
      if (ttsCache.size > 300) ttsCache.clear();
      ttsCache.set(text, out);
      return res.json(out);
    } catch (e) { console.error("TTS:", model, v, e.message); }
  }
  res.status(503).json({ error: "Ovoz yaratib boʻlmadi" });
});

app.listen(process.env.PORT || 3000, () => console.log("Lampa ishga tushdi"));
