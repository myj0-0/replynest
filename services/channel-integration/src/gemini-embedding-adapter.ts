export type EmbeddingTask = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY" | "SEMANTIC_SIMILARITY";

function normalize(values: number[]): number[] {
  const length = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return length ? values.map(value => value / length) : values;
}

export async function embedWithGemini(input: {
  apiKey: string;
  model: string;
  text: string;
  dimensions: 128 | 768 | 1536 | 3072;
  task: EmbeddingTask;
  title?: string;
}): Promise<number[]> {
  const model = input.model.replace(/^models\//, "");
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:embedContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": input.apiKey },
    body: JSON.stringify({
      model: `models/${model}`,
      content: { parts: [{ text: input.text }] },
      taskType: input.task,
      outputDimensionality: input.dimensions,
      ...(input.title && input.task === "RETRIEVAL_DOCUMENT" ? { title: input.title } : {})
    }),
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`Gemini embedding request failed with status ${response.status}`);
  const body = await response.json() as { embedding?: { values?: number[] } };
  const values = body.embedding?.values;
  if (!Array.isArray(values) || values.length !== input.dimensions || values.some(value => !Number.isFinite(value))) {
    throw new Error("Gemini embedding returned an invalid vector");
  }
  return input.dimensions === 3072 ? values : normalize(values);
}
