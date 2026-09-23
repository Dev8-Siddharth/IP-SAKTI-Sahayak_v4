import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type, Modality, LiveServerMessage } from "@google/genai";
import { WebSocketServer } from "ws";
import http from "http";
import dotenv from "dotenv";

dotenv.config();

const RAG_BACKEND_URL = process.env.RAG_BACKEND_URL || "http://127.0.0.1:8000";

function getAiClient(): GoogleGenAI | null {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (key && key.length > 5) {
    return new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
  }
  return null;
}

function pcmToWav(pcmBuffer: Buffer, sampleRate = 16000, numChannels = 1, bitsPerSample = 16): Buffer {
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

async function synthesizeAndStreamSarvamAudio(
  text: string,
  targetLangCode: string,
  clientWs: any,
  checkAborted: () => boolean
) {
  try {
    const sarvamKey = process.env.SARVAM_API_KEY || "sk_i6ajs7tm_DQeZIKDjy7VU6jZGiL28mOn1";
    const res = await fetch("https://api.sarvam.ai/text-to-speech", {
      method: "POST",
      headers: {
        "api-subscription-key": sarvamKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        inputs: [text.slice(0, 480)],
        target_language_code: targetLangCode,
        speaker: "aditya",
        speech_sample_rate: 24000,
        model: "bulbul:v3"
      })
    });
    if (!res.ok) {
      console.warn("Sarvam TTS error status:", res.status);
      return;
    }
    const json = await res.json();
    const base64Wav = json.audios?.[0];
    if (!base64Wav) return;

    const wavBuf = Buffer.from(base64Wav, "base64");
    const dataIdx = wavBuf.indexOf("data");
    const pcmOffset = dataIdx !== -1 && dataIdx + 8 < wavBuf.length ? dataIdx + 8 : 44;
    const pcm = wavBuf.subarray(pcmOffset);

    // Stream 24kHz PCM chunks to client
    const CHUNK_SIZE = 4800;
    for (let offset = 0; offset < pcm.length; offset += CHUNK_SIZE) {
      if (checkAborted() || clientWs.readyState !== clientWs.OPEN) break;
      const slice = pcm.subarray(offset, Math.min(offset + CHUNK_SIZE, pcm.length));
      clientWs.send(JSON.stringify({ audio: slice.toString("base64") }));
      await new Promise(r => setTimeout(r, 85));
    }
  } catch (err) {
    console.error("Sarvam TTS streaming error:", err);
  }
}

async function startSarvamVoiceSession(clientWs: any, language: string, jurisdiction: string, category: string) {
  console.log(`Starting Sarvam AI Voice Assistant session [Lang: ${language}, Jur: ${jurisdiction}]`);

  const langCodeMap: Record<string, string> = {
    Hindi: "hi-IN",
    Kannada: "kn-IN",
    Tamil: "ta-IN",
    Telugu: "te-IN",
    Malayalam: "ml-IN",
    Marathi: "mr-IN",
    Bengali: "bn-IN",
    Gujarati: "gu-IN",
    English: "en-IN"
  };
  const currentLangCode = langCodeMap[language] || "en-IN";

  let currentTurnId = 0;

  const welcomeGreetings: Record<string, string> = {
    Hindi: "नमस्ते! आईपी-शक्ति सहायक वॉयस असिस्टेंट में आपका स्वागत है। मैं आपकी क्या सहायता कर सकता हूँ?",
    Kannada: "ನಮಸ್ಕಾರ! ಐಪಿ-ಶಕ್ತಿ ಸಹಾಯಕ ಧ್ವನಿ ಸಹಾಯಕಕ್ಕೆ ಸುಸ್ವಾಗತ. ನಾನು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಬಹುದು?",
    Tamil: "வணக்கம்! ஐபி-சக்தி சஹாயக் குரல் உதவியாளருக்கு வரவேற்கிறோம். நான் உங்களுக்கு எவ்வாறு உதவ முடியும்?",
    Telugu: "నమస్కారం! ఐపీ-శక్తి సహాయక్ వాయిస్ అసిస్టెంట్‌కి స్వాగతం. నేను మీకు ఎలా సహాయపడగలను?",
    Marathi: "नमस्कार! आयपी-शक्ती सहायक व्हॉईस असिस्टंटमध्ये आपले स्वागत आहे. मी आपली काय मदत करू शकतो?",
    English: "Namaste! Welcome to IP-SAKTI Sahayak Voice Assistant. How can I assist you with Ayurvedic patents and regulations today?"
  };
  const welcomeText = welcomeGreetings[language] || welcomeGreetings.English;

  // Stream initial greeting audio
  synthesizeAndStreamSarvamAudio(welcomeText, currentLangCode, clientWs, () => currentTurnId !== 0);

  let audioChunks: Buffer[] = [];
  let speechDetected = false;
  let silenceTimer: NodeJS.Timeout | null = null;

  const processUserAudio = async (turnId: number) => {
    if (audioChunks.length === 0 || turnId !== currentTurnId) return;

    const fullPcm = Buffer.concat(audioChunks);
    audioChunks = [];
    speechDetected = false;

    if (fullPcm.length < 12000) return;

    try {
      const wavData = pcmToWav(fullPcm, 16000);
      const sarvamKey = process.env.SARVAM_API_KEY || "sk_i6ajs7tm_DQeZIKDjy7VU6jZGiL28mOn1";

      const formData = new FormData();
      const blob = new Blob([wavData], { type: "audio/wav" });
      formData.append("file", blob, "speech.wav");
      formData.append("language_code", currentLangCode);

      const sttRes = await fetch("https://api.sarvam.ai/speech-to-text", {
        method: "POST",
        headers: { "api-subscription-key": sarvamKey },
        body: formData
      });

      if (!sttRes.ok) {
        console.warn("Sarvam STT response status:", sttRes.status);
        return;
      }

      const sttData = await sttRes.json();
      const transcript = sttData.transcript?.trim();
      console.log(`[Turn ${turnId}] Sarvam STT Transcript:`, transcript);

      if (!transcript || turnId !== currentTurnId) return;

      let answerText = "";
      try {
        const ragRes = await fetch(`${RAG_BACKEND_URL}/api/gemini/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [{ role: "user", content: transcript }],
            jurisdiction,
            formulationCategory: category,
            outputLanguage: language
          }),
          signal: AbortSignal.timeout(15000)
        });
        if (ragRes.ok) {
          const ragData = await ragRes.json();
          answerText = ragData.answer || "";
        }
      } catch (e) {
        console.warn("RAG backend fetch error, fallback response:", e);
      }

      if (!answerText) {
        answerText = `Regarding your query on ${transcript}, traditional Ayurvedic formulations are subject to Patents Act Section 3(p) exclusions and require National Biodiversity Authority approval under Section 6.`;
      }

      const cleanAnswer = answerText
        .replace(/[#*`_]/g, "")
        .replace(/\[.*?\]/g, "")
        .slice(0, 260)
        .trim();

      if (turnId !== currentTurnId) return;

      await synthesizeAndStreamSarvamAudio(cleanAnswer, currentLangCode, clientWs, () => turnId !== currentTurnId);
    } catch (err) {
      console.error("Error in Sarvam voice pipeline:", err);
    }
  };

  clientWs.on("message", (data: any) => {
    try {
      const parsed = JSON.parse(data.toString());
      if (parsed.close) {
        currentTurnId++;
        audioChunks = [];
        return;
      }

      if (parsed.audio) {
        const pcmChunk = Buffer.from(parsed.audio, "base64");
        let sum = 0;
        const int16Count = pcmChunk.length / 2;
        for (let i = 0; i < pcmChunk.length; i += 2) {
          const val = pcmChunk.readInt16LE(i) / 32768.0;
          sum += val * val;
        }
        const rms = Math.sqrt(sum / int16Count);

        if (rms > 0.04) {
          if (!speechDetected) {
            speechDetected = true;
            currentTurnId++;
            clientWs.send(JSON.stringify({ interrupted: true }));
            audioChunks = [];
          }
          audioChunks.push(pcmChunk);

          if (silenceTimer) clearTimeout(silenceTimer);
          const turn = currentTurnId;
          silenceTimer = setTimeout(() => {
            processUserAudio(turn);
          }, 900);
        } else if (speechDetected) {
          audioChunks.push(pcmChunk);
        }
      }
    } catch (e) {
      console.error(e);
    }
  });

  clientWs.on("close", () => {
    currentTurnId++;
    if (silenceTimer) clearTimeout(silenceTimer);
    audioChunks = [];
  });
}

async function startServer() {
  const app = express();
  // Frontend runs on port 3000 by default; avoids colliding with Python backend on 8000
  const PORT = Number(process.env.FRONTEND_PORT || process.env.VITE_PORT || (process.env.PORT && process.env.PORT !== "8000" ? process.env.PORT : 3000));
  const server = http.createServer(app);

  // WebSocket Server for Live Voice Assistant
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(request.url || "", `http://${request.headers.host || "localhost"}`);
      if (url.pathname === "/live") {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, request);
        });
      }
    } catch (e) {
      console.error("WebSocket upgrade error:", e);
    }
  });

  wss.on("connection", async (clientWs, req) => {
    console.log("New WebSocket connection to /live received");
    const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
    const language = url.searchParams.get("language") || "English";
    const jurisdiction = url.searchParams.get("jurisdiction") || "India";
    const category = url.searchParams.get("category") || "Unknown";

    const activeAi = getAiClient();
    if (activeAi) {
      try {
        const liveModel = process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview";
        console.log(`[Gemini Live API] Starting session with model ${liveModel} in ${language}`);

        const langInstruction = language === "Auto"
          ? "Automatically detect the Indian language or English spoken by the user in real-time, and respond in that exact same language."
          : `Speak in ${language}. If the user speaks another Indian language, match their spoken language in real-time.`;

        let rejectConnection: ((error: Error) => void) | null = null;
        const connectPromise = activeAi.live.connect({
          model: liveModel,
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
            },
            systemInstruction: `You are the IP-SAKTI Sahayak Voice Assistant, an expert in Ayurvedic Intellectual Property and statutory regulatory law in India.
Jurisdiction: ${jurisdiction}. Formulation Category: ${category}.
RULES:
1. ${langInstruction}
2. Ground all advice strictly in the Indian Patents Act 1970 (Section 3(p) TKDL exclusion, Section 3(d)), Biological Diversity Act 2002 (Section 6 NBA Form III mandatory clearance), and Drugs & Cosmetics Rules (Rule 158B).
3. Keep spoken replies short, natural, concise, and conversational (2-3 sentences max per response).
4. Maintain a continuous, uninterrupted conversation across multiple back-and-forth turns.`,
          },
          callbacks: {
            onmessage: (message: LiveServerMessage) => {
              const parts = message.serverContent?.modelTurn?.parts || [];
              for (const part of parts) {
                if (part.inlineData?.data && clientWs.readyState === clientWs.OPEN) {
                  clientWs.send(JSON.stringify({ audio: part.inlineData.data }));
                }
              }
              if (message.serverContent?.interrupted && clientWs.readyState === clientWs.OPEN) {
                clientWs.send(JSON.stringify({ interrupted: true }));
              }
            },
            onclose: (e: any) => {
              console.log("[Gemini Live API] Session closed:", e?.reason || e);
              if (clientWs.readyState === clientWs.OPEN) clientWs.close();
            },
          }
        });

        const timeoutPromise = new Promise<any>((_, reject) => {
          rejectConnection = reject;
          setTimeout(() => reject(new Error("Connection to Gemini Live API timed out.")), 8000);
        });

        const session = await Promise.race([connectPromise, timeoutPromise]);
        rejectConnection = null;

        const greetingPrompt = language === "Auto"
          ? "Say a brief, warm greeting in English welcoming the user to the IP-SAKTI Sahayak Voice Assistant, and let them know they can speak in English or any Indian language."
          : `Say a brief, warm greeting in ${language} welcoming the user to the IP-SAKTI Sahayak Voice Assistant.`;
        session.sendRealtimeInput({ text: greetingPrompt });

        clientWs.on("message", (data) => {
          try {
            const parsed = JSON.parse(data.toString());
            if (parsed.close) {
              if (clientWs.readyState === clientWs.OPEN) clientWs.close();
              return;
            }
            if (parsed.turnComplete) {
              // User finished speaking; signal audioStreamEnd for instantaneous zero-latency response!
              session.sendRealtimeInput({ audioStreamEnd: true });
              return;
            }
            if (parsed.audio) {
              session.sendRealtimeInput({
                audio: { data: parsed.audio, mimeType: "audio/pcm;rate=16000" }
              });
            }
          } catch (e) {
            console.error("Error processing voice client message:", e);
          }
        });

        clientWs.on("close", () => {
          console.log("[Gemini Live API] Voice client disconnected");
        });

        return;
      } catch (geminiErr) {
        console.warn("Gemini Live API unavailable, falling back to Sarvam Voice session:", geminiErr);
      }
    }

    // Seamless Sarvam AI Live Voice Assistant
    startSarvamVoiceSession(clientWs, language, jurisdiction, category);
  });

  app.use(express.json());

  const RAG_BACKEND_URL = process.env.RAG_BACKEND_URL || "http://127.0.0.1:8000";

  app.post("/api/gemini/chat", async (req, res) => {
    try {
      const { messages, jurisdiction, formulationCategory, outputLanguage } = req.body;

      if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: "messages array is required" });
      }

      // 1. Primary: Forward to the Python RAG Backend with Hybrid Retrieval & Cross-Encoder
      try {
        const ragRes = await fetch(`${RAG_BACKEND_URL}/api/gemini/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages, jurisdiction, formulationCategory, outputLanguage }),
          signal: AbortSignal.timeout(90000)
        });

        if (ragRes.ok) {
          const ragData = await ragRes.json();
          console.log("NODE SERVER PROXY: Received from Python backend:");
          console.log(JSON.stringify(ragData.citations, null, 2));
          return res.json(ragData);
        } else {
          const errDetail = await ragRes.text();
          console.error(`[CRITICAL] Python RAG backend returned status ${ragRes.status}:`, errDetail);
          return res.json({
            answer: "### System Temporarily Unavailable\n\nThe statutory RAG retrieval service returned an error and cannot verify legal citations. To prevent ungrounded responses and legal hallucinations, direct LLM generation without retrieval grounding is disabled. Please check Python backend logs on port 8000.",
            citations: [],
            confidence: "LOW",
            needsHumanEscalation: true,
            isClassicalTKDL: false,
            abstained: true,
            error: `RAG backend error (status ${ragRes.status})`
          });
        }
      } catch (ragErr: any) {
        console.error("[CRITICAL] Python RAG backend connection failed:", ragErr.message || ragErr);
        return res.json({
          answer: "### System Temporarily Unavailable\n\nThe authoritative Python Statutory RAG Backend is currently unreachable. To ensure strict statutory grounding and prevent legal hallucinations, ungrounded LLM generation is completely prohibited. Please verify that the Python backend process is running on port 8000.",
          citations: [],
          confidence: "LOW",
          needsHumanEscalation: true,
          isClassicalTKDL: false,
          abstained: true,
          error: "Statutory RAG Backend unreachable"
        });
      }
    } catch (error: any) {
      console.error("Chat Error:", error);
      res.status(500).json({ error: error.message || "An error occurred while communicating with the AI." });
    }
  });

  app.get("/api/statutes", async (req, res) => {
    try {
      const resp = await fetch(`${RAG_BACKEND_URL}/api/statutes`);
      const data = await resp.json();
      return res.json(data);
    } catch (err: any) {
      return res.status(500).json({ error: "Statutes directory unavailable: " + (err.message || err) });
    }
  });

  app.get("/api/statutes/:parent_id", async (req, res) => {
    try {
      const resp = await fetch(`${RAG_BACKEND_URL}/api/statutes/${encodeURIComponent(req.params.parent_id)}`);
      if (!resp.ok) {
        return res.status(resp.status).json({ error: "Statutory document not found" });
      }
      const data = await resp.json();
      return res.json(data);
    } catch (err: any) {
      return res.status(500).json({ error: "Statute service unavailable: " + (err.message || err) });
    }
  });

  app.post("/api/abs/check", async (req, res) => {
    try {
      const resp = await fetch(`${RAG_BACKEND_URL}/api/abs/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body)
      });
      const data = await resp.json();
      return res.json(data);
    } catch (err: any) {
      return res.status(500).json({ error: "ABS service unavailable: " + (err.message || err) });
    }
  });


  app.post("/api/gemini/translate", async (req, res) => {
    try {
      const { text, targetLanguage } = req.body;
      if (!text || !targetLanguage) {
        return res.status(400).json({ error: "text and targetLanguage are required" });
      }

      const activeAi = getAiClient();
      if (activeAi) {
        const response = await activeAi.models.generateContent({
          model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
          contents: `Translate the following text into ${targetLanguage}. Maintain all statutory citations, legal provisions, section numbers, and formatting accurately:\n\n${text}`,
        });
        return res.json({ translatedText: response.text?.trim() || text });
      }

      return res.json({ translatedText: text, notice: "GEMINI_API_KEY not configured" });
    } catch (err: any) {
      console.error("Gemini Translation Error:", err);
      return res.status(500).json({ error: err.message || "Translation failed" });
    }
  });


  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: { server } },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    // Express 4 uses * for catch-all
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT} and http://127.0.0.1:${PORT}`);
  });
}

startServer();
