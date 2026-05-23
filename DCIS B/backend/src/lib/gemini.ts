import { GoogleGenAI } from '@google/genai';

// Initialize the Gemini AI client
// It automatically picks up the GEMINI_API_KEY environment variable.
const ai = new GoogleGenAI({});

/**
 * Generates text using the Gemini model.
 * 
 * @param prompt - The input prompt text.
 * @param modelOptions - Additional options like temperature or a different model version.
 * @returns The generated response string.
 */
export async function generateText(
  prompt: string, 
  modelOptions?: { model?: string; temperature?: number }
): Promise<string> {
  try {
    const response = await ai.models.generateContent({
      model: modelOptions?.model || 'gemini-2.5-flash',
      contents: prompt,
      config: {
        temperature: modelOptions?.temperature,
      }
    });

    return response.text || '';
  } catch (error) {
    console.error('Error generating content with Gemini:', error);
    throw error;
  }
}

/**
 * Chat conversation with the Gemini model.
 * 
 * @param message - The input message to send to the chat.
 * @returns The response from the chat.
 */
export async function chatWithGemini(message: string): Promise<string> {
  try {
    // You can manage chat state/history if needed, 
    // here we just use the simple generateContent for a stateless call,
    // or you could use ai.chats if you're keeping a stateful chat session.
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: message,
    });

    return response.text || '';
  } catch (error) {
    console.error('Error in chat calculation:', error);
    throw error;
  }
}
