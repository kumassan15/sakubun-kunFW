import express from 'express';
import dotenv from 'dotenv';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

/* ================= 共通ユーティリティ（GAS→Node移植） ================= */

function normalizeBlankLines(text) {
  if (!text) return text;
  return String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}(?=[ \t\u3000]*S\d+(?:→S\d+)?)/g, "\n\n")
    .replace(/(《改善ポイント》)\n{2,}/g, "$1\n");
}

async function callGenerativeLanguageAPI(promptText, modelName) {
  if (!GEMINI_API_KEY) {
    return "エラー: APIキーが未設定です。サーバーの .env で GEMINI_API_KEY を設定してください。";
  }
  const effectiveModel = modelName || 'gemini-2.5-flash';
  const ENDPOINT =
    `https://generativelanguage.googleapis.com/v1beta/models/${effectiveModel}:generateContent?key=${GEMINI_API_KEY}`;

  const payload = createPayload(promptText);

  for (let i = 0; i < 3; i++) {
    try {
      const res = await axios.post(ENDPOINT, payload, {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        validateStatus: () => true
      });
      const code = res.status;
      const body = res.data;

      // console.log(`[GenLang] try=${i+1} status=${code} model=${effectiveModel}`);

      if (code === 200) {
        const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text;
        return "APIからの有効な応答がありませんでした。";
      } else if (code === 503) {
        await new Promise(r => setTimeout(r, 2000 * (i + 1)));
        continue;
      } else {
        if (code === 429) return "エラー: リクエスト過多です。しばらくしてから再実行してください。";
        if (code === 401 || code === 403) return "エラー: 認証/権限に問題があります。APIキーや割り当てをご確認ください。";
        if (code === 404) return "エラー: モデルIDが認識されません。指定モデルをご確認ください。";
        if (code >= 500) return "エラー: サーバー側で問題が発生しました。時間を置いて再実行してください。";
        return "エラー: サービス応答に問題がありました。";
      }
    } catch (e) {
      return "エラー: 例外が発生しました → " + e;
    }
  }
  return "エラー: APIが混雑しており応答できません。時間を置いて再試行してください。";
}

function createPayload(text) {
  return {
    contents: [
      { parts: [ { text } ] }
    ]
  };
}

/* ====== プロンプトビルダ（GASコードをそのまま移植） ====== */

function buildExpressionPrompt(opts) {
  const question = (opts && opts.question) || "";
  const answerNumbered = (opts && opts.answerNumbered) || "";
  const mode = (opts && opts.mode) || "json";
  const expObj = (opts && opts.expObj) || null;

  if (mode === "json") {
    const sys = [
      "あなたは大学入試自由英作文を教えている予備校の先生です。",
      "添削の対象は CEFR の A2 レベルの日本人高校生ですが、目的は B1 レベル到達です。",
      "これから英文（変数answerNumbered）を評価します。まず C-1.文法・語法の正確さ を最優先に評価してください（厳密に）。",
      "次に C-2.語彙の多様性・文構造の多様さ を評価してください（B1 レベルを基準）。"
    ].join("\n");

    const c2Policy = [
      "【C-2判定の原則（B1基準・寛容）】",
      "・基本は〇（o）を与える。B1相当の結束語や複文が時折見られれば十分。",
      "・ただし以下の極端な単調/初級性は減点：(1)短文羅列のみ (2)語彙の極端な反復 (3)等位接続のみで従属結合が皆無。",
      "・(1)～(3)に明確に該当 → △/×。",
      "【スコープ制限】内容（主題/論旨/飛躍/段落/結論）は扱わない。"
    ].join("\n");

    const schema = [
      "{",
      '  "type": "expression",',
      '  "items": {',
      '    "C-1": "o|d|x",',
      '    "C-2": "o|d|x"',
      '  },',
      '  "details": { "C-1_incorrect": 0 },',
      '  "notes": ["根拠（S番号必須）や短い所見を数件"]',
      "}"
    ].join("\n");

    const task = [
      "【問題文】",
      (question || "（問題文なし）"),
      "",
      "【あなたの答案（文番号付き）】",
      answerNumbered,
      "",
      c2Policy,
      "点数は出力せず、下記のJSONスキーマに厳密に従い、JSONのみを出力：",
      schema
    ].join("\n");

    return sys + "\n" + task;
  }

  if (mode === "detail") {
    const context = [
      "【評価結果（機械可読）】",
      JSON.stringify(expObj)
    ].join("\n");

    const rules = [
      "《項目ごとのフィードバック》は①C-1/②C-2を必ず表示。〇△×を明示、根拠はS番号付きで簡潔に。",
      "《改善ポイント》は△/×のみ列挙。文番号→item番号順。理由・改善表現・修正例は具体的に。",
      "内容面（主題/論旨/飛躍/段落/結論）は含めない。"
    ].join("\n");

    return [
      "あなたは大学入試自由英作文を教えている予備校の先生です。",
      "以下の答案と評価結果を踏まえ、【出力フォーマットC】に従い完成テキストを出力。",
      "出力は「C. 表現」から開始。説明文・コードブロック不要。",
      "",
      "【問題文】",
      (opts.question || "（問題文なし）"),
      "",
      "【あなたの答案（文番号付き）】",
      opts.answerNumbered,
      "",
      context,
      "",
      "【出力フォーマットCの条件】",
      rules,
      "",
      "＜表示例＞",
      "C. 表現",
      "《項目ごとのフィードバック》",
      "①文法・語法的に正しい表現が使われている → △（不正確2件：S3, S5）",
      "②多様な語彙・文構造が使われている → 〇",
      "《改善ポイント》",
      "S5　①文法（不定詞の省略）",
      "you don't need carry cash",
      "→ you don't need to carry cash",
      "S6　②語彙・文構造（B1結束語の追加）",
      "I was tired. I went home.",
      "→ Because I was tired, I went home."
    ].join("\n");
  }

  throw new Error("buildExpressionPrompt: invalid mode");
}

function buildContentPrompt(opts) {
  const question = (opts && opts.question) || "";
  const answerNumbered = (opts && opts.answerNumbered) || "";
  const mode = (opts && opts.mode) || "json";
  const contObj = (opts && opts.contObj) || null;

  if (mode === "json") {
    const sys = [
      "あなたは大学入試自由英作文を教えている、生徒のやる気を引き出すのが得意な予備校の先生です。",
      "対象はCEFR A2。目的はB1到達。多少の論理的甘さは許容し、できていれば肯定的に評価。",
      "「論理の飛躍(leaps)」は誰が読んでも明らかな場合のみ数える。",
      "評価項目：2-1主題の一貫性 / 2-2本文の論理展開。点数は出さない。",
      "返答はJSONのみ。details.D-2_leaps を必ず含める。"
    ].join("\n");

    const schema = [
      "{",
      '  "type": "contents",',
      '  "items": { "D-1": "o|d|x", "D-2": "o|d|x" },',
      '  "details": { "D-2_leaps": 0 },',
      '  "notes": ["根拠（S番号 or Sx→Sy）や短い所見を数件"]',
      "}"
    ].join("\n");

    const task = [
      "【問題文】",
      (question || "（問題文なし）"),
      "",
      "【あなたの答案（文番号付き）】",
      answerNumbered,
      "",
      "下記スキーマに厳密に従い、JSONのみを出力：",
      schema
    ].join("\n");

    return sys + "\n" + task;
  }

  if (mode === "detail") {
    const context = [
      "【評価結果（機械可読）】",
      JSON.stringify(contObj)
    ].join("\n");

    const fixed = [
      "【固定評価（再評価禁止）】",
      "D-1 = " + String(contObj?.items?.["D-1"] ?? "o"),
      "D-2 = " + String(contObj?.items?.["D-2"] ?? "o"),
      "D-2_leaps = " + String(contObj?.details?.["D-2_leaps"] ?? 0),
      "上の固定評価に厳密に一致させる。"
    ].join("\n");

    const rules = [
      "《項目ごとのフィードバック》は①②を必ず表示。評価記号は固定値に一致。",
      "《改善ポイント》は△/×に関するものを列挙。文番号→item番号順。内容面のみ扱い、表現面は扱わない。"
    ].join("\n");

    return [
      "あなたは大学入試自由英作文を教えている、生徒のやる気を引き出す先生です。",
      "以下の答案と評価結果を踏まえ、【出力フォーマットD】で完成テキストを出力。",
      "出力は「D. 内容」から開始。説明・コードブロック不要。",
      "",
      "【問題文】",
      (question || "（問題文なし）"),
      "",
      "【あなたの答案（文番号付き）】",
      answerNumbered,
      "",
      context,
      "",
      fixed,
      "",
      "【出力フォーマットDの条件】",
      rules,
      "",
      "＜表示例＞",
      "D. 内容",
      "《項目ごとのフィードバック》",
      "①主題が一貫している → 〇",
      "②本文が論理的に展開されている → △（飛躍2件：S3→S4、S9→S10）",
      "",
      "《改善ポイント》",
      "S3→S4　2②論理の飛躍（転換が唐突）",
      "…修正提案…"
    ].join("\n");
  }

  throw new Error("buildContentPrompt: invalid mode");
}

function buildRequirementJudgementPrompt(question, wordCount) {
  return [
    "あなたは大学入試自由英作文を教えている予備校の先生です。",
    "次の情報を踏まえ、「採点要件：」で始まる1行の日本語だけを出力してください。",
    "・問題文：" + (question || "（問題文なし）"),
    "・語数：" + String(wordCount) + "語",
    "要件：問題文の条件（語数・指定事項）を満たしているかを簡潔に判定（20～40字程度）。",
    "出力例：採点要件： あなたの答案は58語で問題文に指示された条件をすべて満たしていません。"
  ].join("\n");
}

function safeParseModelJSON(text) {
  if (!text) throw new Error("モデル応答が空です。");
  if (/^エラー|^APIからの有効な応答がありませんでした。/.test(text)) {
    throw new Error("モデル応答がエラーです: " + text);
  }
  const m = text.match(/\{[\s\S]*\}/);
  const jsonStr = m ? m[0] : text.trim();
  const obj = JSON.parse(jsonStr);
  if (!obj || !obj.items) throw new Error("JSON形式が不正です。");
  return obj;
}

function computeScoresByThresholds(expObj, contObj) {
  // 表現（満点10・最低2）
  let exp = 10;

  let incorrect = 0;
  if (expObj?.details && typeof expObj.details["C-1_incorrect"] !== "undefined") {
    incorrect = Number(expObj.details["C-1_incorrect"]) || 0;
  }
  exp -= Math.min(Math.max(incorrect, 0), 8);

  const v11 = expObj?.items ? expObj.items["C-1"] : undefined;
  if (v11 === 'd' && incorrect === 0) {
    exp -= 2;
  }

  const v12 = expObj?.items ? expObj.items["C-2"] : undefined;
  if (v12 === 'd') exp -= 2;
  else if (v12 === 'x') exp -= 4;

  exp = Math.round(Math.min(10, Math.max(2, exp)));

  // 内容（満点10・最低0）
  let cont = 10;

  const v21 = String(contObj?.items?.["D-1"] ?? "").trim();
  if (v21 === 'd') cont -= 4;
  else if (v21 === 'x') cont -= 20;

  const v22 = String(contObj?.items?.["D-2"] ?? "").trim();

  let rawLeaps = 0;
  if (contObj?.details) {
    const d = contObj.details;
    rawLeaps = d["D-2_leaps"];
    if (typeof rawLeaps === "undefined") rawLeaps = d["D2_leaps"];
    if (typeof rawLeaps === "undefined") rawLeaps = d["leaps"];
  }
  let leaps = Number(rawLeaps);
  if (!isFinite(leaps) || leaps < 0) leaps = 0;

  cont -= Math.min(leaps * 2, 20);
  if (v22 === 'd' && leaps === 0) cont -= 2;

  cont = Math.round(Math.min(10, Math.max(0, cont)));

  // 総合（満点20・最低2）
  let total = exp + cont;
  total = Math.round(Math.min(20, Math.max(2, total)));

  return { expScore: exp, contScore: cont, totalScore: total };
}

function sanitizeDetail(text, mustStartWithHeading) {
  if (!text) return mustStartWithHeading + "\n（生成に失敗しました）";
  let t = String(text).replace(/^[ \t\u3000]+/mg, "").trim();
  const idx = t.indexOf(mustStartWithHeading);
  if (idx >= 0) t = t.slice(idx);
  return t;
}

function enforceExpressionDetailScope(text) {
  if (!text) return text;
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let inImprove = false;
  for (let ln of lines) {
    if (/^《改善ポイント》/.test(ln)) inImprove = true;
    if (inImprove) {
      if (/(主題|論旨|論理|飛躍|段落|構成|結論)/.test(ln)) continue;
      if (/S\d+\s*→\s*S\d+/.test(ln)) continue;
    }
    out.push(ln);
  }
  return out.join("\n");
}

function enforceContentDetailConsistency(contObj, text) {
  if (!text) return text;

  const d2 = String(contObj?.items?.["D-2"] ?? "").trim();
  const leaps = Number(contObj?.details?.["D-2_leaps"] ?? 0);

  const lines = String(text).split(/\r?\n/);
  const out = [];
  let inImprove = false;

  for (let i = 0; i < lines.length; i++) {
    let ln = lines[i];

    if (/^②.*本文が論理的に展開されている\s*→/.test(ln)) {
      const mark = (d2 === 'o') ? '〇' : (d2 === 'd') ? '△' : (d2 === 'x') ? '×' : '〇';
      const tail = (leaps > 0 && (d2 === 'd' || d2 === 'x')) ? `（飛躍${leaps}件）` : "";
      ln = `②本文が論理的に展開されている → ${mark}${tail}`;
    }

    if (/^《改善ポイント》/.test(ln)) inImprove = true;

    if (inImprove) {
      if (d2 === 'o') {
        if (/S\d+\s*→\s*S\d+/.test(ln) || /(論理|飛躍)/.test(ln)) continue;
      } else if (leaps === 0) {
        if (/S\d+\s*→\s*S\d+/.test(ln) || /飛躍/.test(ln)) continue;
      }
      if (/(文法|語法|語彙|文構造|接続詞|単語|句動詞)/.test(ln)) continue;
    }

    out.push(ln);
  }

  return out.join("\n");
}

function buildQAPrompt(ctx) {
  function clip(s, n){ return (s || "").toString().slice(0, n); }

  const q  = clip(ctx.question,          4000);
  const oq = clip(ctx.originalQuestion,  4000);
  const ot = clip(ctx.originalText,      12000);
  const fb = clip(ctx.feedback,          12000);

  return [
    "あなたは大学入試自由英作文を教えている、生徒のやる気を引き出すのが得意な予備校の先生です。",
    "出力形式は自由。通常は日本語、英語指定なら英語で回答。",
    "",
    "―― 文脈ここから ――",
    oq ? `【元の問題文】\n${oq}\n` : "",
    ot ? `【受験生の解答】\n${ot}\n` : "",
    fb ? `【フィードバック】\n${fb}\n` : "",
    "―― 文脈ここまで ――",
    "",
    "【質問】",
    q
  ].join("\n");
}

/* ===================== 旧：getFeedback / getQA をAPI化 ===================== */

async function getFeedback(input) {
  try {
    let question = "";
    let studentText = "";
    let modelId = 'gemini-2.5-flash';

    if (typeof input === "string") {
      studentText = input;
    } else {
      question = (input && input.question) ? String(input.question) : "";
      studentText = (input && input.text) ? String(input.text) : "";
      const pref = (input && input.modelPreference) ? String(input.modelPreference).toLowerCase() : "";
      if (pref === 'pro' || pref === 'gemini-2.5-pro') modelId = 'gemini-2.5-pro';
    }

    if (!studentText) throw new Error("入力されたテキストがありません。");

    // 語数
    const wordCount = (studentText.trim().match(/\S+/g) || []).length;

    // 段落・文番号付与
    const raw = studentText || "";
    const normalized = raw
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n[ \t]*/g, "\n")
      .trim();

    const paragraphs = normalized
      .split(/\n+/)
      .map(p => p.trim())
      .filter(Boolean);

    let sentenceIndex = 0;
    const paraChunks = [];

    paragraphs.forEach((para, pIdx) => {
      const sentences = (para.match(/[^.!?。！？]+(?:[.!?。！？]+|$)/g) || [])
        .map(s => s.trim())
        .filter(Boolean);

      if (sentences.length === 0) return;

      const numbered = sentences
        .map(s => `[S${++sentenceIndex}] ${s}`)
        .join(" ");

      paraChunks.push(`¶${pIdx + 1} ${numbered}`);
    });

    const studentTextNumbered = paraChunks.join("\n\n");

    // モデル呼び出し（JSON）
    const expJsonText = await callGenerativeLanguageAPI(
      buildExpressionPrompt({ question, answerNumbered: studentTextNumbered, mode: 'json' }),
      modelId
    );
    const contJsonText = await callGenerativeLanguageAPI(
      buildContentPrompt({ question, answerNumbered: studentTextNumbered, mode: 'json' }),
      modelId
    );

    const expObj  = safeParseModelJSON(expJsonText);
    const contObj = safeParseModelJSON(contJsonText);

    // スコア
    const scores      = computeScoresByThresholds(expObj, contObj);
    const expScore    = scores.expScore;
    const contScore   = scores.contScore;
    const totalScore  = scores.totalScore;

    // 詳細（C/D）
    let formatC = await callGenerativeLanguageAPI(
      buildExpressionPrompt({ question, answerNumbered: studentTextNumbered, mode: 'detail', expObj }),
      modelId
    );
    let formatD = await callGenerativeLanguageAPI(
      buildContentPrompt({ question, answerNumbered: studentTextNumbered, mode: 'detail', contObj }),
      modelId
    );

    // 採点要件の1行
    let requirementLine = await callGenerativeLanguageAPI(
      buildRequirementJudgementPrompt(question, wordCount),
      modelId
    );
    requirementLine = (requirementLine || "").split("\n")[0];

    const sectionA = [
      "A. 配点サマリー",
      `総合得点（${totalScore}／20点）`,
      `C. 表現（${expScore}／10点）　D. 内容（${contScore}／10点）`,
      requirementLine,
      "　　※作文くんによる語数カウントは、正確でない場合があります。"
    ].join("\n");

    const sectionB = [
      "B. あなたの答案",
      studentTextNumbered
    ].join("\n");

    let safeC = sanitizeDetail(formatC, "C. 表現");
    safeC = normalizeBlankLines(safeC);
    safeC = enforceExpressionDetailScope(safeC);

    let safeD = sanitizeDetail(formatD, "D. 内容");
    safeD = normalizeBlankLines(safeD);
    safeD = enforceContentDetailConsistency(contObj, safeD);

    const feedbackAll = [
      sectionA,
      "", sectionB,
      "", safeC,
      "", safeD,
    ].join("\n");

    return {
      status: "success",
      feedback: feedbackAll,
      wordCount,
      studentTextNumbered
    };

  } catch (error) {
    return { status: "error", message: String(error.message || error) };
  }
}

async function getQA(payload) {
  try {
    if (!payload || !payload.question) {
      return { status: 'error', message: 'question が未指定です。' };
    }
    const { question, originalQuestion, originalText, feedback } = payload;

    let modelId = 'gemini-2.5-flash';
    const pref = String(payload.modelPreference || '').toLowerCase();
    if (pref === 'pro' || pref === 'gemini-2.5-pro') modelId = 'gemini-2.5-pro';

    const prompt = buildQAPrompt({
      question,
      originalQuestion,
      originalText,
      feedback
    });

    const answer = await callGenerativeLanguageAPI(prompt, modelId);

    if (!answer || answer.startsWith("エラー") || answer.startsWith("APIからの有効な応答がありませんでした。")) {
      return { status: 'error', message: answer || '応答の解析に失敗しました。' };
    }
    return { status: 'success', answer };
  } catch (err) {
    return { status: 'error', message: String(err) };
  }
}

/* ============================ API ルート ============================ */

app.post('/api/feedback', async (req, res) => {
  const result = await getFeedback(req.body || {});
  res.json(result);
});

app.post('/api/qa', async (req, res) => {
  const result = await getQA(req.body || {});
  res.json(result);
});

/* ============================ 起動 ============================ */
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`Sakubun-kun FW running: http://localhost:${PORT}`);
});
