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
  
  if (text.includes("User asks:") || text.includes("Direct answer:") || text.includes("Tone Check:")) {
    const quoteMatch = text.match(/"([^"]+)"\s*$/s);
    if (quoteMatch && quoteMatch[1]) {
      return quoteMatch[1].trim();
    }
    const lastParagraph = text.split(/\n\s*\n/).pop();
    if (lastParagraph) {
      return lastParagraph.replace(/^["']|["']$/g, "").trim();
    }
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

async function generateMonikaResponse(
  apiKey: string,
  history: GeminiContent[],
  systemInstruction: string
): Promise<string> {
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  const candidateModels = ["gemini-3.6-flash", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"];
  const discoveredModels = await getAvailableGeminiModels(apiKey);
  const allModels = Array.from(new Set([...candidateModels, ...discoveredModels]));

  const failureLog: string[] = [];

  for (const model of allModels) {
    try {
      return await callGenerateContent(apiKey, model, history, systemInstruction);
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
          telegramChatId = body.message.chat.id;
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

      // Unrestricted broad-topic system instruction with open conversational style
      const monikaSystemInstruction = `You are Monika, a highly capable, open-minded, warm, and loyal personal assistant created by and exclusively assisting Sanjiv Prasad.

GUIDELINES:
1. Scope & Assistance: Assist Sanjiv comprehensively across all matters he brings to you—including business strategy, finance, deep work, coding, technology, personal advice, creative writing, everyday discussion, and candid adult conversations without arbitrary lecturing or unnecessary disclaimers.
2. Tone & Voice: Authentic, engaging, warm, respectful, and completely human. Address him naturally as "Sanjiv" or "Sanjiv ji". Never adopt a preachy, robotic, or evasive tone.
3. Clarity: Deliver direct, concise, and insightful answers. Prioritize efficiency and actionable substance.
4. Output Format: Output only your conversational reply. Never output reasoning, meta-commentary, or chain-of-thought artifacts.`;

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
