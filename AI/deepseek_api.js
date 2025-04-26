import { fetch } from 'node-fetch-native';
import 'dotenv/config';

const API_KEY = process.env.DEEPSEEK_API_KEY;

export async function askDeepSeek(prompt) {
  try {
    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorData}`);
    }

    return await response.json(); // <-- ¡Esta línea faltaba!

  } catch (error) {
    console.error("Error en la API:", error.message);
    return null;
  }
}