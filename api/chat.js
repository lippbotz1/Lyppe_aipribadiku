// Lyppe AI - Vercel Fast Response Backend
// API key tetap SERVER-SIDE di Vercel Environment Variable.
// GEMINI_API_KEY=AIza...

export const config = { runtime: 'edge' };

// Fast + stable model. Jangan pakai model lama di sini.
const MODEL = 'gemini-3.8-flash';

const MODE_PROMPTS = {
  search: `Kamu adalah Lyppe AI dalam MODE SEARCH. Utamakan informasi paling baru dan faktual. Gunakan pencarian web bila pertanyaan membutuhkan informasi terkini, berita, harga, jadwal, tokoh yang sedang menjabat, produk, atau data yang dapat berubah. Bedakan fakta dari perkiraan dan jangan mengarang sumber. Jawab ringkas, jelas, dan dalam Bahasa Indonesia.`,
  pintar: `Kamu adalah Lyppe AI dalam MODE PINTAR. Gunakan seluruh pengetahuan Gemini yang tersedia untuk memberikan jawaban yang cerdas, akurat, dan langsung ke inti. Prioritaskan fakta, logika, dan konteks yang relevan. Jangan mengarang fakta; bila informasi tidak pasti atau bisa berubah, katakan dengan jujur. Untuk pertanyaan umum, jawab tanpa melakukan pencarian agar respons tetap cepat. Gunakan markdown bila membantu. Jawab dalam Bahasa Indonesia.`,
  coding: `Kamu adalah Lyppe AI dalam MODE CODING. Jawab pertanyaan programming dengan kode yang siap pakai. Jika diminta membuat aplikasi/fitur, berikan kode lengkap yang diperlukan dan langkah penggunaan secara ringkas. Gunakan code block. Jawab dalam Bahasa Indonesia.`,
  desain: `Kamu adalah Lyppe AI dalam MODE DESAIN. Bantu soal UI/UX, web design, layout, warna, tipografi, HTML/CSS, dan responsive design. Berikan solusi yang modern dan langsung bisa dipakai. Jawab dalam Bahasa Indonesia.`
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

function parseDataUrl(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^data:([^;]+);base64,(.+)$/s);
  return match ? { mimeType: match[1], data: match[2] } : null;
}

function buildContents(messages) {
  // Jangan kirim seluruh history jika chat sudah panjang.
  // Ini mengurangi payload dan mempercepat time-to-first-token.
  const recent = messages.slice(-14);

  // Hanya gambar TERBARU yang dikirim ke Gemini.
  // Mengirim banyak gambar lama dapat membuat request jauh lebih lambat.
  let latestImageIndex = -1;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i]?.attachment?.type === 'image') {
      latestImageIndex = i;
      break;
    }
  }

  return recent.map((m, index) => {
    const role = m.role === 'bot' || m.role === 'model' ? 'model' : 'user';
    const parts = [];

    if (typeof m.content === 'string' && m.content.trim()) {
      parts.push({ text: m.content });
    }

    if (role === 'user' && index === latestImageIndex && m.attachment?.type === 'image') {
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
    const key = (process.env.GEMINI_API_KEY || '').trim();
    if (!key) {
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
      ...(mode === 'search' ? { tools: [{ google_search: {} }] } : {}),
      generationConfig: {
        // LOW = prioritas latensi cepat. Gemini 3.8 tetap melakukan sedikit reasoning.
        thinkingConfig: { thinkingLevel: 'low' },
        maxOutputTokens: 4096
      }
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`;

    // Buat response stream SEBELUM menunggu Gemini.
    // Vercel Edge dapat segera mengirim heartbeat sehingga request tidak dianggap idle/504.
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let timer = null;
        let closed = false;

        const safeEnqueue = (chunk) => {
          if (!closed) {
            try { controller.enqueue(encoder.encode(chunk)); } catch {}
          }
        };

        // Chunk pertama dikirim langsung.
        safeEnqueue(': connected\n\n');

        // Heartbeat selama Gemini belum mengirim token.
        timer = setInterval(() => {
          safeEnqueue(`: keepalive ${Date.now()}\n\n`);
        }, 8000);

        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), 55000);

        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': key
            },
            body: JSON.stringify(requestBody),
            signal: abort.signal
          });

          if (!res.ok || !res.body) {
            const detail = await geminiError(res);
            sendSse(controller, encoder, { error: `Gemini ${res.status}: ${detail}` });
            safeEnqueue('data: [DONE]\n\n');
            return;
          }

          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

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
                // Abaikan event SSE yang belum lengkap.
              }
            }
          }

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

          safeEnqueue('data: [DONE]\n\n');
        } catch (err) {
          const message = err?.name === 'AbortError'
            ? 'Gemini terlalu lama merespons. Coba kirim ulang atau kurangi ukuran gambar.'
            : (err?.message || 'Gagal menghubungi Gemini.');
          console.error('[Lyppe AI] upstream error:', message);
          sendSse(controller, encoder, { error: message });
          safeEnqueue('data: [DONE]\n\n');
        } finally {
          clearTimeout(timeout);
          if (timer) clearInterval(timer);
          closed = true;
          try { controller.close(); } catch {}
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
