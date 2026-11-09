// Classify a check-in call. Keyword rules always run; the LLM (if configured) refines answered calls.
const EMERGENCY = /\b(fell|fall|fallen|can'?t get up|help me|need help|chest|can'?t breathe|breathing|bleeding|ambulance|stroke)\b|넘어|도와|숨|가슴/i;
const CONCERN = /\b(dizzy|pain|hurt|sick|ache|didn'?t eat|haven'?t eaten|forgot (my )?(medicine|pills)|lonely|sad|tired|weak|confused)\b|어지|아파|외로/i;
const STATUSES = ['ok', 'concern', 'emergency', 'no_answer'];

function keywordClassify(userText) {
  if (!userText.trim()) return { status: 'no_answer', reason: 'No response from the senior.' };
  if (EMERGENCY.test(userText)) return { status: 'emergency', reason: 'Possible fall or medical emergency mentioned.' };
  if (CONCERN.test(userText)) return { status: 'concern', reason: 'Mentioned feeling unwell or a missed routine.' };
  return { status: 'ok', reason: 'Said they are fine.' };
}

const SYSTEM_PROMPT =
  'You classify a wellness check-in call with an older adult living alone. Return JSON: ' +
  '{"status":"ok|concern|emergency|no_answer","reason":"short","location_in_home":"string or null",' +
  '"summary_for_family":"1-2 sentences"}. emergency = fall, cannot get up, chest pain, trouble breathing, ' +
  'bleeding, confusion, asks for help. concern = dizziness, pain, missed meals or medicine, low mood. ' +
  'no_answer = the senior never spoke. When unsure between levels, choose the more serious one.';

async function llmClassify(transcript, { key, model }, fetchImpl = fetch) {
  if (!key) return null;
  try {
    const r = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: transcript || '(no transcript)' },
        ],
      }),
    });
    if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}`);
    const j = await r.json();
    const out = JSON.parse(j.choices[0].message.content);
    if (!STATUSES.includes(out.status)) throw new Error(`unexpected status ${out.status}`);
    return out;
  } catch (e) {
    console.warn('LLM classify failed, using keywords:', e.message);
    return null;
  }
}

// Same policy as the prototype: silence is always no_answer; otherwise the LLM result wins when available.
async function classifyCall({ transcript = '', userText = '' }, openai, fetchImpl) {
  const kw = keywordClassify(userText);
  if (kw.status === 'no_answer') return { ...kw, source: 'keywords' };
  const llm = await llmClassify(transcript, openai, fetchImpl);
  return llm ? { ...llm, source: 'llm' } : { ...kw, source: 'keywords' };
}

module.exports = { keywordClassify, llmClassify, classifyCall };
