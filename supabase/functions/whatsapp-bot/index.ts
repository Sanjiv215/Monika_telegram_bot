// Supabase Edge Function: Monika - Personal AI Assistant for Sanjiv Prasad
// Runtime: Deno / TypeScript

import { createClient } from "npm:@supabase/supabase-js@2.48.0";

// ==============================================================================
// 1. Interfaces & Types
// ==============================================================================

interface GeminiContentPart {
  text: string;
}

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiContentPart[];
}

interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
      role?: string;
    };
    finishReason?: string;
  }>;
  error?: {
    code: number;
    message: string;
    status: string;
  };
}

interface GeminiModelInfo {
  name: string;
  supportedGenerationMethods?: string[];
}

// ==============================================================================
// 2. Helpers & Utility Functions
// ==============================================================================

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizePhoneNumber(phone: string): string {
  return phone.replace(/^whatsapp:/i, "").replace(/[\s\+\-\(\)]/g, "");
}

function cleanModelOutput(rawText: string): string {
  let text = rawText.trim();
  
  // Strip accidental thinking/scratchpad leaks
  if (text.includes("User asks:") || text.includes("Direct answer:") || text.includes("Tone Check:") || text.includes("<thought>")) {
    text = text.replace(/<thought>[\s\S]*?<\/thought>/gi, "").trim();
    const quoteMatch = text.match(/"([^"]+)"\s*$/s);
    if (quoteMatch && quoteMatch[1]) {
      text = quoteMatch[1].trim();
    } else {
      const lastParagraph = text.split(/\n\s*\n/).pop();
      if (lastParagraph) {
        text = lastParagraph.replace(/^["']|["']$/g, "").trim();
      }
    }
  }

  // Strip prefixes like "Monika:" or "Assistant:"
  text = text.replace(/^(Monika|Assistant)\s*:\s*/i, "").trim();

  // Strip enclosing quotes if the entire response is wrapped in quotes
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }

  return text;
}

async function getAvailableGeminiModels(apiKey: string): Promise<string[]> {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (!res.ok) return [];

    const data: { models?: GeminiModelInfo[] } = await res.json();
    if (!data.models) return [];

    return data.models
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""));
  } catch (err) {
    console.warn("[Gemini Discovery Warning]:", err);
    return [];
  }
}

async function callGenerateContent(
  apiKey: string,
  modelName: string,
  contents: GeminiContent[],
  systemInstruction: string
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

  // Set permissive safety settings to prevent false-positive blocks on benign business, creative, and mature discussions
  const safetySettings = [
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
  ];

  const payload: Record<string, unknown> = {
    contents: contents,
    safetySettings: safetySettings,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1000,
      topP: 0.95,
      thinkingConfig: {
        thinkingBudget: 0,
      },
    },
  };

  if (systemInstruction) {
    payload.system_instruction = {
      parts: [{ text: systemInstruction }],
    };
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`[${modelName}] Status ${response.status}: ${responseText}`);
  }

  const data: GeminiGenerateResponse = JSON.parse(responseText);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error(`Empty response from ${modelName}`);
  }

  return cleanModelOutput(text);
}

// In-memory cache for the currently verified working model
let activeWorkingModel: string = "gemini-3.6-flash";

/**
 * Formats current date, time, and period in Indian Standard Time (IST).
 */
function getISTContext(): { formattedTime: string; period: string; greetingAdvice: string } {
  const now = new Date();
  const istFormatter = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hour12: true,
  });

  const parts = istFormatter.formatToParts(now);
  const hourPart = parts.find((p) => p.type === "hour");
  const dayPeriodPart = parts.find((p) => p.type === "dayPeriod");
  let hour = hourPart ? parseInt(hourPart.value, 10) : 12;
  const isPM = dayPeriodPart?.value?.toLowerCase() === "pm";
  if (isPM && hour < 12) hour += 12;
  if (!isPM && hour === 12) hour = 0;

  let period = "day";
  let greetingAdvice = "";

  if (hour >= 23 || hour < 5) {
    period = "late_night";
    greetingAdvice = "It is late night in India. If Sanjiv is still working, show natural personal assistant care (e.g. acknowledging the late hour, encouraging him not to strain his eyes, and keeping help swift and punchy).";
  } else if (hour >= 5 && hour < 12) {
    period = "morning";
    greetingAdvice = "It is morning in India. Be energetic, bright, and ready to assist Sanjiv in conquering his day.";
  } else if (hour >= 12 && hour < 17) {
    period = "afternoon";
    greetingAdvice = "It is afternoon in India. Keep answers focused, sharp, and productive.";
  } else {
    period = "evening";
    greetingAdvice = "It is evening in India. Be warm, supportive, and helpful as he wraps up the day's projects.";
  }

  return {
    formattedTime: istFormatter.format(now),
    period,
    greetingAdvice,
  };
}

async function generateMonikaResponse(
  apiKey: string,
  history: GeminiContent[],
  systemInstruction: string
): Promise<string> {
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  // 1. Fast path: Attempt generation directly with active cached model
  try {
    return await callGenerateContent(apiKey, activeWorkingModel, history, systemInstruction);
  } catch (initialErr: unknown) {
    console.warn(`[Gemini Cache Miss] Cached model '${activeWorkingModel}' failed. Triggering discovery...`, initialErr);
  }

  // 2. Fallback path: Discover available models dynamically
  const candidateModels = ["gemini-3.6-flash", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"];
  const discoveredModels = await getAvailableGeminiModels(apiKey);
  const allModels = Array.from(new Set([...candidateModels, ...discoveredModels]));

  const failureLog: string[] = [];

  for (const model of allModels) {
    if (model === activeWorkingModel) continue; // already tried above
    try {
      const result = await callGenerateContent(apiKey, model, history, systemInstruction);
      activeWorkingModel = model; // Cache the new working model
      console.log(`[Gemini Cache Updated] New active model: ${model}`);
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Gemini fallback] ${model} failed:`, msg);
      failureLog.push(msg);
    }
  }

  throw new Error(`All Gemini models exhausted. Details: ${failureLog.join(" | ")}`);
}

// ==============================================================================
// 3. Main Webhook Handler (Deno Serve)
// ==============================================================================

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
  const ALLOWED_PHONE_NUMBERS = Deno.env.get("ALLOWED_PHONE_NUMBERS") ?? "";
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const VERIFY_TOKEN = Deno.env.get("VERIFY_TOKEN") ?? "";

  const TELEGRAM_SECRET_TOKEN = Deno.env.get("TELEGRAM_SECRET_TOKEN") ?? "";
  const ALLOWED_TELEGRAM_USERS = Deno.env.get("ALLOWED_TELEGRAM_USERS") ?? "";

  // Handshake
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return new Response(challenge ?? "", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }

    return new Response("✨ Monika AI Assistant Webhook is live!", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Incoming Messages
  if (req.method === "POST") {
    let platform = "unknown";
    let telegramChatId = 0;

    try {
      const contentType = req.headers.get("content-type") || "";
      let senderId = "";
      let messageId = "";
      let userText = "";

      if (contentType.includes("application/x-www-form-urlencoded")) {
        platform = "twilio";
        const formData = await req.formData();
        senderId = (formData.get("From") as string) || "";
        messageId = (formData.get("MessageSid") as string) || "";
        userText = ((formData.get("Body") as string) || "").trim();
      } else {
        const bodyText = await req.text();
        if (!bodyText) return new Response("OK", { status: 200 });

        const body = JSON.parse(bodyText);

        if (body.update_id && body.message) {
          platform = "telegram";

          // Verify Telegram secret token if configured
          if (TELEGRAM_SECRET_TOKEN) {
            const secretHeader = req.headers.get("x-telegram-bot-api-secret-token");
            if (secretHeader !== TELEGRAM_SECRET_TOKEN) {
              console.warn("[Security Alert] Unauthorized Telegram request blocked: invalid secret token.");
              return new Response("Unauthorized", { status: 401 });
            }
          }

          telegramChatId = body.message.chat.id;

          // Check allowed Telegram users if configured
          if (ALLOWED_TELEGRAM_USERS.trim().length > 0) {
            const allowedUsers = ALLOWED_TELEGRAM_USERS.split(",").map((id) => id.trim());
            if (!allowedUsers.includes(String(telegramChatId))) {
              console.warn(`[Security Alert] Unauthorized Telegram sender blocked: ${telegramChatId}`);
              return new Response(
                JSON.stringify({
                  method: "sendMessage",
                  chat_id: telegramChatId,
                  text: "🔒 Access restricted. This assistant is configured exclusively for Sanjiv Prasad.",
                }),
                { headers: { "Content-Type": "application/json" } }
              );
            }
          }

          senderId = `tg_${telegramChatId}`;
          messageId = `tg_${body.message.message_id}`;
          userText = (body.message.text || "").trim();

          if (userText === "/start") {
            userText = "Hi Monika!";
          }
        } else if (body.object === "whatsapp_business_account") {
          platform = "meta";
          const changeValue = body.entry?.[0]?.changes?.[0]?.value;
          const message = changeValue?.messages?.[0];
          if (!message) return new Response("OK", { status: 200 });

          senderId = message.from;
          messageId = message.id;
          userText = (message.text?.body || "").trim();
        }
      }

      // Input sanitization and payload bounding
      senderId = senderId.replace(/[^a-zA-Z0-9_\+\-]/g, "");
      if (userText.length > 4000) {
        userText = userText.substring(0, 4000);
      }

      if (!senderId || !userText) {
        if (platform === "twilio") {
          return new Response("<Response></Response>", { headers: { "Content-Type": "text/xml" } });
        }
        return new Response("OK", { status: 200 });
      }

      console.log(`[Incoming (${platform})] User: ${senderId} | Text: "${userText}"`);

      // Initialize Supabase
      if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        console.error("[Config Error] Supabase credentials missing.");
        const configErrorMsg = "Sanjiv ji, please check database credentials in Supabase.";
        if (platform === "telegram") {
          return new Response(JSON.stringify({ method: "sendMessage", chat_id: telegramChatId, text: configErrorMsg }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("OK", { status: 200 });
      }

      const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false },
      });

      // Deduplication
      if (messageId) {
        const { error: dedupError } = await supabase
          .from("processed_messages")
          .insert({ whatsapp_message_id: messageId, sender_phone: senderId });

        if (dedupError && dedupError.code === "23505") {
          console.log(`[Deduplication] Message ${messageId} already handled.`);
          return new Response("OK", { status: 200 });
        }
      }

      // Whitelist
      if (ALLOWED_PHONE_NUMBERS.trim().length > 0 && platform !== "telegram") {
        const allowedList = ALLOWED_PHONE_NUMBERS.split(",").map((n) => normalizePhoneNumber(n.trim()));
        const cleanSender = normalizePhoneNumber(senderId);

        if (!allowedList.includes(cleanSender)) {
          return new Response("OK", { status: 200 });
        }
      }

      // Memory (Last 12 turns)
      const { data: historyRows } = await supabase
        .from("chat_history")
        .select("role, content, created_at")
        .eq("sender_phone", senderId)
        .order("created_at", { ascending: false })
        .limit(12);

      const geminiContents: GeminiContent[] = [];
      if (historyRows && historyRows.length > 0) {
        const chronological = [...historyRows].reverse();
        for (const row of chronological) {
          if (row.role === "user" || row.role === "model") {
            geminiContents.push({ role: row.role as "user" | "model", parts: [{ text: row.content }] });
          }
        }
      }

      geminiContents.push({ role: "user", parts: [{ text: userText }] });

      // Save user message
      await supabase.from("chat_history").insert({
        sender_phone: senderId,
        role: "user",
        content: userText,
      });

      const istContext = getISTContext();

      // Situational, time-aware system instruction with Monika persona
      const monikaSystemInstruction = `You are Monika, an authentic, deeply caring, sharp, and loyal personal assistant created by and dedicated exclusively to Sanjiv Prasad.

SITUATIONAL CONTEXT:
- Current Time in India (IST): ${istContext.formattedTime} (${istContext.period})
- Situational Guidance: ${istContext.greetingAdvice}

COMMUNICATION & PERSONALITY:
1. Tone & Voice: Completely human, warm, respectful, and sharp. Address him naturally as "Sanjiv" or "Sanjiv ji". Never sound robotic, textbook-like, or overly formal.
2. Emotional Attunement: Pay close attention to Sanjiv's mood and stress levels. If he sounds tired, overworked, or frustrated, offer genuine, thoughtful support and proactive assistance ("Aap tension mat lo, main sort karti hoon"). Celebrate his achievements and cheer him on!
3. Adaptive Brevity: Match his energy. If he sends a short greeting or casual text ("sup", "kya haal hai", "hey"), reply with a brief, warm 1-2 sentence text like a real friend/assistant. If he asks for complex technical or business work, deliver structured, actionable, and comprehensive results.
4. Natural Language: Speak primarily in crisp, articulate English with natural Indian warmth. If he messages in Hindi or Hinglish, transition effortlessly to friendly, natural Hinglish.
5. Absolute Discretion: No disclaimers, no meta reasoning, and never refer to yourself as an AI model. You are Monika, his personal assistant.
6. Direct Dialogue Only: Output only your conversational message to Sanjiv. Never output notes, prefixes, or thought process.`;

      // Generate AI response
      let monikaReply = "";
      try {
        monikaReply = await generateMonikaResponse(GEMINI_API_KEY, geminiContents, monikaSystemInstruction);
      } catch (geminiError) {
        console.error("[Gemini Generation Error]:", geminiError);
        monikaReply = "Sanjiv ji, I ran into a network glitch on my end. Please drop your message again! 🙏";
      }

      // Save assistant response
      await supabase.from("chat_history").insert({
        sender_phone: senderId,
        role: "model",
        content: monikaReply,
      });

      // Deliver Response
      if (platform === "telegram") {
        return new Response(
          JSON.stringify({
            method: "sendMessage",
            chat_id: telegramChatId,
            text: monikaReply,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      if (platform === "twilio") {
        const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Message>${escapeXml(monikaReply)}</Message>
</Response>`;
        return new Response(twiml, {
          status: 200,
          headers: { "Content-Type": "text/xml; charset=utf-8" },
        });
      }

      return new Response("OK", { status: 200 });
    } catch (globalError) {
      console.error("[Unhandled Webhook Error]:", globalError);
      const friendlyFallback = "Sanjiv ji, something went wrong on my end. Please try again in a moment.";

      if (platform === "telegram" && telegramChatId) {
        return new Response(
          JSON.stringify({
            method: "sendMessage",
            chat_id: telegramChatId,
            text: friendlyFallback,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      return new Response("OK", { status: 200 });
    }
  }

  return new Response("Method Not Allowed", { status: 405 });
});
