// Lyppe AI - Vercel Serverless Function
// Gemini API key HARUS disimpan di Vercel Environment Variable:
// GEMINI_API_KEY=AIza...

export const config = { runtime: 'edge' };

const DEFAULT_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite'
];

const MODE_PROMPTS = {
  search: `Kamu adalah Lyppe AI dalam MODE SEARCH. Fokus menjawab pertanyaan user dengan fakta yang akurat, jelas, dan terstruktur. Sajikan informasi seperti hasil pencarian: poin-poin penting, penjelasan singkat, dan jika relevan sebutkan sumber/kategori. Hindari opini pribadi, utamakan informasi faktual. Format dengan heading dan bullet bila perlu. Jawab dalam Bahasa Indonesia.`,
  pintar: `Kamu adalah Lyppe AI dalam MODE PINTAR. Jawab pertanyaan user dengan cerdas, lengkap, dan mendalam. Gunakan penalaran yang baik, berikan contoh bila perlu, dan susun jawaban secara terstruktur dengan markdown. Jawab dalam Bahasa Indonesia.`,
  coding: `Kamu adalah Lyppe AI dalam MODE CODING. Khusus menjawab pertanyaan seputar programming: tulis kode yang LENGKAP dan SIAP PAKAI, sertakan komentar di kode, jelaskan cara kerja kode, berikan contoh penggunaan, dan sebutkan bahasa/framework yang dipakai. Selalu pakai code block dengan bahasa yang sesuai. Jika user minta dibuatkan aplikasi/fitur, buat kode lengkap dari awal sampai siap run. Jawab dalam Bahasa Indonesia.`,
  desain: `Kamu adalah Lyppe AI dalam MODE DESAIN. Khusus membantu soal UI/UX, desain web, layout, warna, tipografi, dan CSS. Berikan saran desain yang modern, estetis, dan bisa langsung dipraktikkan. Sertakan kode HTML/CSS bila perlu dengan styling yang menarik (gradient, shadow, animasi, responsive). Sebutkan prinsip desain yang dipakai. Jawab dalam Bahasa Indonesia.`
};

function responseJson(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function getKeys() {
  const one = (process.env.GEMINI_API_KEY || '').trim();
  const many = (process.env.GEMINI_API_KEYS || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
  return [...new Set([one, ...many].filter(Boolean))];
}

function getModels() {
  const configured = (process.env.GEMINI_MODEL || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
  return [...new Set([...configured, ...DEFAULT_MODELS])];
}

function parseDataUrl(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^data:([^;]+);base64,(.+)$/s);
  return match ? { mimeType: match[1], data: match[2] } : null;
}

function buildContents(messages) {
  return messages.map(m => {
    const role = m.role === 'bot' || m.role === 'model' ? 'model' : 'user';
    const parts = [];

    if (typeof m.content === 'string' && m.content.trim()) {
      parts.push({ text: m.content });
    }

    if (role === 'user' && m.attachment?.type === 'image') {
      const image = parseDataUrl(m.attachment.dataUrl);
      if (image) {
        parts.push({
          inlineData: {
            mimeType: image.mimeType,
            data: image.data
          }
        });
      }
    }

    return parts.length ? { role, parts } : null;
  }).filter(Boolean);
}

async function geminiError(res) {
  try {
    const data = await res.json();
    return data?.error?.message || `Gemini HTTP ${res.status}`;
  } catch {
    return `Gemini HTTP ${res.status}`;
  }
}

function sendSse(controller, encoder, payload) {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
}

export default async function handler(req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return responseJson({ error: 'Method not allowed' }, 405, cors);

  try {
    const keys = getKeys();
    if (!keys.length) {
      return responseJson({
        error: 'GEMINI_API_KEY belum tersedia. Tambahkan GEMINI_API_KEY di Vercel → Settings → Environment Variables, lalu REDEPLOY.'
      }, 500, cors);
    }

    const body = await req.json().catch(() => null);
    if (!body || !Array.isArray(body.messages) || !body.messages.length) {
      return responseJson({ error: 'Messages harus berupa array yang tidak kosong.' }, 400, cors);
    }

    const contents = buildContents(body.messages);
    if (!contents.length) return responseJson({ error: 'Pesan kosong.' }, 400, cors);

    const mode = body.mode || 'pintar';
    const systemPrompt = (MODE_PROMPTS[mode] || MODE_PROMPTS.pintar) +
      ' Jika ditanya tentang siapa pembuat atau pengembangmu, jawab: "Saya dibuat oleh Alipp, dia adalah pengembangku".';

    const requestBody = {
      contents,
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: {
        maxOutputTokens: 8192,
        thinkingConfig: {
          thinkingLevel: mode === 'coding' ? 'high' : 'medium'
        }
      }
    };

    const models = getModels();
    let upstream = null;
    let lastError = 'Tidak ada respons dari Gemini.';

    // Coba semua kombinasi key + model. API key TIDAK dikirim dari browser.
    for (const key of keys) {
      for (const model of models) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': key
            },
            body: JSON.stringify(requestBody)
          });

          if (res.ok && res.body) {
            upstream = res;
            console.log(`[Lyppe AI] Gemini OK: ${model}`);
            break;
          }

          const detail = await geminiError(res);
          lastError = `${model}: ${detail}`;
          console.error(`[Lyppe AI] ${lastError}`);
        } catch (err) {
          lastError = `${model}: ${err?.message || 'Network error'}`;
          console.error(`[Lyppe AI] ${lastError}`);
        }
      }
      if (upstream) break;
    }

    if (!upstream) {
      return responseJson({
        error: `Gemini gagal diakses. Cek GEMINI_API_KEY dan API/kuota Gemini di Google AI Studio. Detail: ${lastError}`
      }, 502, cors);
    }

    const stream = new ReadableStream({
      async start(controller) {
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        let buffer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;

              const raw = trimmed.slice(5).trim();
              if (!raw || raw === '[DONE]') continue;

              try {
                const chunk = JSON.parse(raw);
                const text = (chunk.candidates?.[0]?.content?.parts || [])
                  .map(part => part.text || '')
                  .join('');
                if (text) sendSse(controller, encoder, { text });
              } catch {
                // Abaikan SSE line yang belum lengkap / bukan JSON.
              }
            }
          }

          // Proses event terakhir kalau tidak diakhiri newline.
          const last = buffer.trim();
          if (last.startsWith('data:')) {
            try {
              const chunk = JSON.parse(last.slice(5).trim());
              const text = (chunk.candidates?.[0]?.content?.parts || [])
                .map(part => part.text || '')
                .join('');
              if (text) sendSse(controller, encoder, { text });
            } catch {}
          }

          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } catch (err) {
          console.error('[Lyppe AI] stream error:', err);
          try {
            sendSse(controller, encoder, { error: err?.message || 'Stream error' });
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          } catch {}
        }
      }
    });

    return new Response(stream, {
      status: 200,
      headers: {
        ...cors,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      }
    });
  } catch (err) {
    console.error('[Lyppe AI] server error:', err);
    return responseJson({ error: err?.message || 'Server error' }, 500, cors);
  }
}
