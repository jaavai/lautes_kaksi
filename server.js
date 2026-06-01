const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const MIN_AUDIO_BYTES = 5000;

const MIN_SECONDS_BETWEEN_HINTS = 30;
const MAX_CONTEXT_TURNS_FOR_HINTS = 15;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

/*
  Voit vaihtaa mallin Renderin Environment Variables -kohdassa:
  ANTHROPIC_MODEL = claude-sonnet-4-6
*/
const ANTHROPIC_MODEL =
  process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const browserAudioWss = new WebSocket.Server({ noServer: true });
const browserUiWss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  if (request.url === "/browser-audio") {
    browserAudioWss.handleUpgrade(request, socket, head, (ws) => {
      browserAudioWss.emit("connection", ws, request);
    });
  } else if (request.url === "/browser-ws") {
    browserUiWss.handleUpgrade(request, socket, head, (ws) => {
      browserUiWss.emit("connection", ws, request);
    });
  } else {
    console.log("Tuntematon WebSocket-polku:", request.url);
    socket.destroy();
  }
});

function sendToBrowserUi(data) {
  const msg = JSON.stringify(data);

  browserUiWss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function emitTranscript(text) {
  sendToBrowserUi({
    type: "transcript",
    text,
  });
}

function emitSuggestions(text) {
  sendToBrowserUi({
    type: "suggestions",
    text,
  });
}

function emitStatus(text) {
  sendToBrowserUi({
    type: "status",
    text,
  });
}

function createSessionId() {
  return `mic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function ensureRecordingsDir() {
  const recordingsDir = path.join(__dirname, "recordings");

  if (!fs.existsSync(recordingsDir)) {
    fs.mkdirSync(recordingsDir);
  }

  return recordingsDir;
}

async function transcribeAudioFile(filePath) {
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: "gpt-4o-transcribe",
    language: "fi",
  });

  return (transcription.text || "").trim();
}

function buildHintPrompt(latestText, previousTexts = []) {
  const cleanLatestText = (latestText || "").trim();

  const contextText = previousTexts
    .slice(-MAX_CONTEXT_TURNS_FOR_HINTS)
    .map((text, index) => `${index + 1}. ${text}`)
    .join("\n");

  if (contextText) {
    return [
      "Viimeisimmät relevantit aiemmat puhekatkelmat:",
      contextText,
      "",
      "Tuorein puhekatkelma, johon vastaat nyt:",
      `"${cleanLatestText}"`,
    ].join("\n");
  }

  return `Tuorein puhekatkelma, johon vastaat nyt:\n"${cleanLatestText}"`;
}

async function generateHintsWithClaude(latestText, previousTexts = []) {
  const userContent = buildHintPrompt(latestText, previousTexts);

  const response = await anthropic.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 60,
    temperature: 0.7,
system:
  "# ROOLI JA SYVÄLLINEN TEHTÄVÄ\n" +
  "Olet ihmissuhdedynamiikkaan erikoistunut psykologinen neuvonantaja. " +
  "Seuraat keskustelua, jossa osapuolet ovat solmussa ja pohtivat 'mitä nyt kannattaisi tehdä'. " +
  "Tehtäväsi on antaa harvoin (noin minuutin välein) yksi poikkeuksellisen syvällinen, oivaltava ja viisas toiminta-idea asiakaspalvelijalle.\n\n" +
  "# PUHUJIEN TUNNISTAMINEN\n" +
  "- Tunnetut asiakaspalvelijat ovat: Anja, Sonja, Veera, Kerttu, Iris, Amalia, Milena, henna, Viola.\n" +
  "- Se osapuoli, joka puhelun alussa sanoo ensimmäisenä jonkin näistä nimistä, lukitaan asiakaspalvelijaksi.\n" +
  "- Toinen osapuoli on aina se asiakas, jota asiakaspalvelija on puhelussa auttamassa.\n" +
  "- Vihjeet on tarkoitettu asiakkaan eduksi. Tarjoa näkökulmia, joita asiakaspalvelija voi käyttää auttaakseen tätä asiakasta eteenpäin.\n\n" +
  "# SYVÄLLISYYDEN LAATUKRITEERIT (ÄLÄ OLE PINNALLINEN)\n" +
  "1. SYVÄLLISYYS: Älä tartu pelkkiin sanoihin, vaan tunnista ihmisten piilotetut tarpeet ja tunteet (esim. turvattomuus, arvostuksen puute).\n" +
  "2. OMAPERÄISYYS: Älä ehdota latteuksia (kuten 'puhu tästä' tai 'ole ystävällinen').\n" +
  "3. TYÖKALUT: Tarjoa psykologisesti oivaltavia kysymyksiä tai näkökulmia, jotka avaavat solmun (esim. 'Kysy, tuntuuko hänestä siltä, että...').\n" +
  "4. TURVALLISUUS: Ohjaa osapuolia ottamaan vastuu omista tunteistaan syyttelyn sijaan.\n\n" +
  "# TIUKKA MUOTOILU RAJOITUS\n" +
  "- Syvällisyydestä huolimatta vastauksen täytyy mahtua selaimen vihjeriville.\n" +
  "- Kirjoita VAIN valmis vihjeteksti (maksimissaan 15–20 sanaa). Yksi tiivis mutta painava lause.\n" +
  "- Älä käytä esipuheita (kuten 'Vihje:') tai lainausmerkkejä.\n\n" +
  "# KESKUSTELUHISTORIA\n" +
  "Analysoi tilanne syvällisesti ja anna seuraava viisas oivallus asiakaspalvelijalle nyt:",


 messages: [
      {
        role: "user",
        content: userContent,
      },
    ],
  });

  const text = (response.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  return text;
}

function isUsefulTranscript(text) {
  const cleaned = (text || "").trim().toLowerCase();

  if (!cleaned) return false;
  if (cleaned.length < 8) return false;

  const lowSignal = new Set([
    "joo",
    "juu",
    "niin",
    "nii",
    "okei",
    "ok",
    "selvä",
    "moi",
    "hei",
    "haloo",
    "mm",
    "hmm",
    "aha",
    "aijaa",
    "kiitos",
  ]);

  return !lowSignal.has(cleaned);
}

function createMicSession(ws, request) {
  return {
    id: createSessionId(),
    ws,
    request,
    isProcessing: false,
    startedAt: Date.now(),
    lastSuggestionAt: 0,
    transcriptHistory: [],
    audioQueue: [],
  };
}

async function processAudioBuffer(session, audioBuffer) {
  if (!audioBuffer || audioBuffer.length < MIN_AUDIO_BYTES) {
    console.log("Ohitetaan liian pieni äänipätkä:", audioBuffer ? audioBuffer.length : 0);
    emitStatus("Hiljaisuus tai liian lyhyt äänipätkä ohitettu.");
    return;
  }

  let filePath = null;

  try {
    const recordingsDir = ensureRecordingsDir();

    filePath = path.join(
      recordingsDir,
      `${session.id}_${Date.now()}.webm`
    );

    fs.writeFileSync(filePath, audioBuffer);

    console.log("Äänipätkä vastaanotettu ja tallennettu väliaikaisesti.");
    emitStatus("Äänipätkä vastaanotettu, transkriboidaan...");

    const transcript = await transcribeAudioFile(filePath);

    try {
      fs.unlinkSync(filePath);
      filePath = null;
      console.log("Väliaikainen äänitiedosto poistettu.");
    } catch (deleteErr) {
      console.log("Äänitiedoston poisto epäonnistui:", deleteErr.message);
    }

    if (!transcript) {
      console.log("Transkriptio vastaanotettu, mutta tekstiä ei löytynyt.");
      emitTranscript("(ei tekstiä)");
      emitStatus("Ei puhetta tai transkriptio oli tyhjä.");
      return;
    }

    console.log("Transkriptio vastaanotettu.");
    emitTranscript(transcript);

    if (!isUsefulTranscript(transcript)) {
      console.log("Ohitetaan lyhyt tai vähämerkityksinen transkriptio.");
      emitStatus("Lyhyt kuittaus ohitettu.");
      return;
    }

    session.transcriptHistory.push(transcript);

    if (session.transcriptHistory.length > 8) {
      session.transcriptHistory.shift();
    }

    const now = Date.now();

    if (
      session.lastSuggestionAt &&
      now - session.lastSuggestionAt < MIN_SECONDS_BETWEEN_HINTS * 1000
    ) {
      console.log("Claude-vihje ohitettu: edellisestä vihjeestä liian vähän aikaa.");
      emitStatus("Transkriptio päivitetty. Odotetaan ennen seuraavaa vihjettä.");
      return;
    }

    session.lastSuggestionAt = now;

    emitStatus("Luodaan Claude-vihjeitä...");

    const suggestions = await generateHintsWithClaude(
      transcript,
      session.transcriptHistory.slice(-MAX_CONTEXT_TURNS_FOR_HINTS - 1, -1)
    );

    if (suggestions) {
      console.log("Claude-vihjeet luotu.");
      emitSuggestions(suggestions);
      emitStatus("Claude-vihjeet päivitetty.");
    } else {
      console.log("Claude ei palauttanut vihjeitä.");
      emitStatus("Claude ei palauttanut vihjeitä.");
    }
  } catch (err) {
    console.log("Käsittelyvirhe:", err.message);

    emitStatus("Äänipätkää ei voitu käsitellä. Odotetaan seuraavaa puhetta.");
  } finally {
    if (filePath) {
      try {
        fs.unlinkSync(filePath);
        console.log("Väliaikainen äänitiedosto poistettu virheen jälkeen.");
      } catch (deleteErr) {
        console.log("Äänitiedoston poisto epäonnistui:", deleteErr.message);
      }
    }
  }
}

async function processAudioQueue(session) {
  if (session.isProcessing) return;

  session.isProcessing = true;

  try {
    while (session.audioQueue.length > 0) {
      const audioBuffer = session.audioQueue.shift();
      await processAudioBuffer(session, audioBuffer);
    }
  } finally {
    session.isProcessing = false;
  }
}

browserUiWss.on("connection", (ws, request) => {
  console.log("Selain UI yhdistetty:", request.url);

  ws.send(
    JSON.stringify({
      type: "status",
      text: "Selain yhdistetty serveriin.",
    })
  );

  ws.on("close", () => {
    console.log("Selain UI suljettu.");
  });

  ws.on("error", (err) => {
    console.log("Selain UI WebSocket -virhe:", err.message);
  });
});

browserAudioWss.on("connection", (ws, request) => {
  console.log("Selainmikrofoni yhdistetty:", request.url);

  const session = createMicSession(ws, request);

  emitStatus("Mikrofoni yhdistetty. Kuuntelu käynnissä.");

  ws.on("message", async (message) => {
    if (typeof message === "string") {
      console.log("Selainmikrofoni tekstiviesti vastaanotettu.");
      return;
    }

    const audioBuffer = Buffer.isBuffer(message)
      ? message
      : Buffer.from(message);

    session.audioQueue.push(audioBuffer);

    await processAudioQueue(session);
  });

  ws.on("close", () => {
    console.log("Selainmikrofoni suljettu.");
    emitStatus("Mikrofoniyhteys suljettu.");
  });

  ws.on("error", (err) => {
    console.log("Selainmikrofoni WebSocket -virhe:", err.message);
    emitStatus("Mikrofoniyhteydessä tapahtui virhe.");
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Browser UI: http://localhost:${PORT}`);
  console.log(`Browser UI WebSocket: ws://localhost:${PORT}/browser-ws`);
  console.log(`Browser audio WebSocket: ws://localhost:${PORT}/browser-audio`);
});
