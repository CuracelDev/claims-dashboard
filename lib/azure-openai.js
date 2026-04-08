// Azure OpenAI client for Curacel Claims Dashboard
// Models: gpt-4.1 (complex tasks), gpt-4.1-mini (lighter tasks)

const AZURE_CONFIG = {
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  baseUrl: process.env.AZURE_OPENAI_BASE_URL,
  apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2025-01-01-preview',
};

// Model mappings (replaces Anthropic models)
export const MODELS = {
  // gpt-4.1 replaces claude-opus-4-5 (complex reasoning)
  GPT_41: 'gpt-4.1',
  // gpt-4.1-mini replaces claude-sonnet-4 (lighter tasks)
  GPT_41_MINI: 'gpt-4.1-mini',
};

/**
 * Call Azure OpenAI Chat Completions API
 * @param {Object} options
 * @param {string} options.model - Deployment name (gpt-4.1 or gpt-4.1-mini)
 * @param {Array} options.messages - Chat messages array
 * @param {string} [options.systemPrompt] - System prompt (will be prepended to messages)
 * @param {number} [options.maxTokens=1000] - Max tokens to generate
 * @param {number} [options.temperature=0.7] - Temperature for sampling
 * @param {Object} [options.responseFormat] - Response format for structured outputs
 * @returns {Promise<string>} - Generated text content
 */
export async function chatCompletion({
  model,
  messages,
  systemPrompt,
  maxTokens = 1000,
  temperature = 0.7,
  responseFormat,
}) {
  const { apiKey, baseUrl, apiVersion } = AZURE_CONFIG;
  
  if (!apiKey || !baseUrl) {
    throw new Error('Azure OpenAI credentials not configured');
  }

  // Build messages array with optional system prompt
  const allMessages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;

  const url = `${baseUrl}openai/deployments/${model}/chat/completions?api-version=${apiVersion}`;
  
  const body = {
    messages: allMessages,
    max_tokens: maxTokens,
    temperature,
  };

  // Add response_format for structured outputs (JSON mode)
  if (responseFormat) {
    body.response_format = responseFormat;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Azure OpenAI API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

/**
 * Call Azure OpenAI with JSON structured output
 * Uses response_format with json_schema for guaranteed valid JSON
 * @param {Object} options - Same as chatCompletion plus jsonSchema
 * @param {Object} options.jsonSchema - JSON schema for structured output
 * @returns {Promise<Object>} - Parsed JSON object
 */
export async function chatCompletionJSON({
  model,
  messages,
  systemPrompt,
  maxTokens = 500,
  temperature = 0.3,
  jsonSchema,
  schemaName = 'response',
}) {
  const responseFormat = jsonSchema
    ? {
        type: 'json_schema',
        json_schema: {
          name: schemaName,
          strict: true,
          schema: jsonSchema,
        },
      }
    : { type: 'json_object' };

  const content = await chatCompletion({
    model,
    messages,
    systemPrompt,
    maxTokens,
    temperature,
    responseFormat,
  });

  try {
    return JSON.parse(content);
  } catch {
    console.error('[Azure OpenAI] Failed to parse JSON:', content);
    return null;
  }
}

/**
 * Simple text completion (convenience wrapper)
 * @param {string} prompt - User prompt
 * @param {string} [model] - Model to use (defaults to gpt-4.1-mini)
 * @param {Object} [options] - Additional options
 * @returns {Promise<string>} - Generated text
 */
export async function complete(prompt, model = MODELS.GPT_41_MINI, options = {}) {
  return chatCompletion({
    model,
    messages: [{ role: 'user', content: prompt }],
    ...options,
  });
}
