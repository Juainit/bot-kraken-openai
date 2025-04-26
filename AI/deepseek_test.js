import { askDeepSeek } from './deepseek_api.js';

const testPrompt = "Explica en una frase cómo funciona esto";

const response = await askDeepSeek(testPrompt);
console.log("Respuesta de DeepSeek:", response?.choices[0]?.message?.content || "Error");