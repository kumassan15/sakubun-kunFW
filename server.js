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

/* ========= 構造化（JSONスキーマつき）生成：修正理由を必須にする ========= */

// JSON スキーマ付きで生成を強制
async function callGenerativeJSON(promptText, modelName, responseSchema) {
  if (!GEMINI_API_KEY) {
    throw new Error("APIキー未設定");
  }
  const effectiveModel = modelName || 'gemini-2.5-flash';
  const ENDPOINT =
    `https://generativelanguage.googleapis.com/v1beta/models/${effectiveModel}:generateContent?key=${GEMINI_API_KEY}`;

  const payload = {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: {
      response_mime_type: "application/json",
      response_schema: responseSchema
    }
  };

  const res = await axios.post(ENDPOINT, payload, {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    validateStatus: () => true
  });

  if (res.status !== 200) {
    throw new Error(`structured API error: ${res.status}`);
  }
  const text = res?.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("structured API empty");
  return JSON.parse(text);
}

// C. 表現（改善項目）スキーマ：reason を必須
const IMPROVE_SCHEMA_C = {
  type: "object",
  additionalProperties: false,
  required: ["heading", "items"],
  properties: {
    heading: { type: "string", const: "C. 表現" },
    items: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "category", "error", "fix", "reason"],
        properties: {
          id: { type: "string" },          // "S5" / "S3→S4" など
          category: { type: "string" },    // "①文法" 等
          error: { type: "string", minLength: 1 },
          fix: { type: "string", minLength: 1 },
          reason: { type: "string", minLength: 8 } // ★必須
        }
      }
    }
  }
};

// D. 内容（改善項目）スキーマ：reason を必須
const IMPROVE_SCHEMA_D = {
  type: "object",
  additionalProperties: false,
  required: ["heading", "items"],
  properties: {
    heading: { type: "string", const: "D. 内容" },
    items: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "category", "error", "fix", "reason"],
        properties: {
          id: { type: "string" },          // "S3→S4" など
          category: { type: "string" },    // "2②論理の展開" 等
          error: { type: "string", minLength: 1 },
          fix: { type: "string", minLength: 1 },
          reason: { type: "string", minLength: 8 }
        }
      }
    }
  }
};

/* ====== プロンプトビルダ（評価用JSONは従来通り / 詳細はJSON改善配列に変更） ====== */

function buildExpressionPrompt(opts) {
  const question = (opts && opts.question) || "";
  const answerNumbered = (opts && opts.answerNumbered) || "";
  const mode = (opts && opts.mode) || "json";
  const expObj = (opts && opts.expObj) || null;

  if (mode === "json") {
    const sys = [
      "あなたは大学入試自由英作文を教えている、生徒のやる気を引き出すのが得意な予備校の先生です。",
      "添削の対象は日本人高校生です。",
      "添削の目的は、日本の大学受験に合格できるCEFRのB1レベルの文章が書けるようにすることです。",
      "これから英文（変数answerNumbered）を評価してください。その際、C-1.文法・語法の正確さ を最優先に評価してください（英語母国語話者としての自然さを問わないが、厳密に）。",
      "次に C-2.語彙の多様性・文構造の多様さ を評価してください（B1 レベルを基準）。"
    ].join("\n");

    const c2Policy = [
      "【C-2判定の原則（Bレベル基準・寛容）】",
      "基本は〇（o）を与える。B1レベル相当の語彙や、B1レベル相当の複文（because/when/if/that などの従属節・関係詞・to不定詞句 等）が少なくとも時折見られれば十分。",
      "多少の反復や単純文の混在はB1レベルへの移行段階として許容する。",
      "ただし、以下の「明確にB1レベル 基準を満たさない極端なケース」 は減点：(1)ほぼすべてが短い単純文の羅列 (2)同一フレーズの反復が支配的で、新しい語彙の導入が極めて少ない (3)等位接続のみで従属結合が皆無。",
      "(1)～(3)に明確に該当 → △/×。",
      "【スコープ制限】内容（主題/論旨/飛躍/矛盾/段落/結論）や結束表現(Howeverなど)の欠如は扱わない。"
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
    // ★ 改善項目（JSON配列）を作らせる
    const ctx = [
      "あなたは日本人高校生向けの英作文指導者です。",
      "以下の答案に対する『表現面の改善項目』を JSON で返してください。",
      "必ず items に各項目 { id, category, error, fix, reason } を含めること。",
      "reason は高校生にも分かる日本語で1行。過剰な意味改変を避け、原文に即した最小修正を提示。"
    ].join("\n");

    return [
      ctx, "",
      "【問題文】",
      (opts.question || "（問題文なし）"),
      "",
      "【あなたの答案（文番号付き）】",
      opts.answerNumbered,
      "",
      "【評価結果（機械可読）】",
      JSON.stringify(expObj || {})
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
      "添削の対象は、日本人高校生です。",
      "添削の目的は、日本の大学受験に合格できるCEFRのB1レベルの文章が書けるようにすることです。",
      "主張・理由・具体例・結論といった基本的な論理構造が取れているかを重視し、できていれば高く評価してください。",
      "多少の論理的甘さは許容し、基本的な論理構造が取れていれば肯定的に評価してください。",
      "「論理の飛躍(leaps)」や「論理の矛盾（順接・逆接など）」は誰が読んでも明らかな場合のみ数えてください。明らかな結束表現（Howeverなど）の欠如は減点してください。",
      "評価項目：2-1主題の一貫性 / 2-2本文の論理展開。",
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
    // ★ 改善項目（JSON配列）を作らせる
    const ctx = [
      "あなたは日本人高校生向けの英作文指導者です。",
      "以下の答案に対する『内容面の改善項目』を JSON で返してください。",
      "必ず items に各項目 { id, category, error, fix, reason } を含めること。",
      "reason は高校生にも分かる日本語で1行。Sx→Sy のように文間関係の改善も可。"
    ].join("\n");

    return [
      ctx, "",
      "【問題文】",
      (opts.question || "（問題文なし）"),
      "",
      "【あなたの答案（文番号付き）】",
      opts.answerNumbered,
      "",
      "【評価結果（機械可読）】",
      JSON.stringify(contObj || {})
    ].join("\n");
  }

  throw new Error("buildContentPrompt: invalid mode");
}

function buildRequirementJudgementPrompt(question, wordCount) {
  return [
    "あなたは大学入試の採点者です。",
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
      if (/(主題|論旨|論理|飛躍|矛盾|段落|構成|結論)/.test(ln)) continue;
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
        if (/S\d+\s*→\s*S\d+/.test(ln) || /(論理|飛躍|矛盾)/.test(ln)) continue;
      } else if (leaps === 0) {
        if (/S\d+\s*→\s*S\d+/.test(ln) || /論理|飛躍|矛盾/.test(ln)) continue;
      }
      if (/(文法|語法|語彙|文構造|接続詞|単語|句動詞)/.test(ln)) continue;
    }

    out.push(ln);
  }

  return out.join("\n");
}

/* ================= レンダリング（JSON→人間可読） ================= */

function renderCOverview(expObj) {
  const c1 = String(expObj?.items?.["C-1"] ?? "o");
  const c2 = String(expObj?.items?.["C-2"] ?? "o");
  const incorrect = Number(expObj?.details?.["C-1_incorrect"] ?? 0);
  const map = { o: "〇", d: "△", x: "×" };
  const c1Line = `①文法・語法的に正しい表現が使われている → ${map[c1] || "〇"}${incorrect > 0 ? `（不正確${incorrect}件）` : ""}`;
  const c2Line = `②多様な語彙・文構造が使われている → ${map[c2] || "〇"}`;
  return [ "C. 表現", "《項目ごとのフィードバック》", c1Line, c2Line ].join("\n");
}

function renderDOverview(contObj) {
  const d1 = String(contObj?.items?.["D-1"] ?? "o");
  const d2 = String(contObj?.items?.["D-2"] ?? "o");
  const leaps = Number(contObj?.details?.["D-2_leaps"] ?? 0);
  const map = { o: "〇", d: "△", x: "×" };
  const d1Line = `①主題が一貫している → ${map[d1] || "〇"}`;
  const d2Line = `②本文が論理的に展開されている → ${map[d2] || "〇"}${(d2 === 'd' || d2 === 'x') && leaps > 0 ? `（飛躍${leaps}件）` : ""}`;
  return [ "D. 内容", "《項目ごとのフィードバック》", d1Line, d2Line ].join("\n");
}

function renderImproveSection(heading, obj) {
  // obj: { heading, items: [{id, category, error, fix, reason}, ...] }
  const lines = [];
  // Overview（①/②）は別で付けるので、ここは《改善ポイント》のみ
  lines.push("《改善ポイント》");
  for (const it of (obj.items || [])) {
    lines.push(`${it.id}　${it.category}`);
    lines.push(`【エラー】${it.error}`);
    lines.push(`【修正例】${it.fix}`);
    lines.push(`【修正理由】${it.reason}`);
  }
  return [heading, ...lines].join("\n");
}

function validateImproveJSON(obj) {
  if (!obj || obj.heading == null || !Array.isArray(obj.items)) return "malformed";
  if (obj.items.length === 0) return "no_items";
  for (const [i, it] of obj.items.entries()) {
    if (!it.id || !it.error || !it.fix || !it.reason) return `missing_fields_at_${i}`;
    if (String(it.reason).trim().length < 8) return `short_reason_at_${i}`;
  }
  return "ok";
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

    // モデル呼び出し（JSON）評価
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

    // 《改善ポイント》を JSON（必須キー）で取得
    let improveC = await callGenerativeJSON(
      buildExpressionPrompt({ question, answerNumbered: studentTextNumbered, mode: 'detail', expObj }),
      modelId,
      IMPROVE_SCHEMA_C
    ).catch(() => null);

    // 失敗時のワンモアトライ
    if (!improveC || validateImproveJSON(improveC) !== "ok") {
      improveC = await callGenerativeJSON(
        buildExpressionPrompt({ question, answerNumbered: studentTextNumbered, mode: 'detail', expObj }),
        modelId,
        IMPROVE_SCHEMA_C
      ).catch(() => null);
    }

    let improveD = await callGenerativeJSON(
      buildContentPrompt({ question, answerNumbered: studentTextNumbered, mode: 'detail', contObj }),
      modelId,
      IMPROVE_SCHEMA_D
    ).catch(() => null);

    if (!improveD || validateImproveJSON(improveD) !== "ok") {
      improveD = await callGenerativeJSON(
        buildContentPrompt({ question, answerNumbered: studentTextNumbered, mode: 'detail', contObj }),
        modelId,
        IMPROVE_SCHEMA_D
      ).catch(() => null);
    }

    // レンダリング
    const cOverview = renderCOverview(expObj);
    const dOverview = renderDOverview(contObj);

    const cImprove = improveC && validateImproveJSON(improveC) === "ok"
      ? renderImproveSection("C. 表現", improveC)
      : "C. 表現\n《項目ごとのフィードバック》\n（生成に失敗しました）\n《改善ポイント》\n（生成に失敗しました）";

    const dImprove = improveD && validateImproveJSON(improveD) === "ok"
      ? renderImproveSection("D. 内容", improveD)
      : "D. 内容\n《項目ごとのフィードバック》\n（生成に失敗しました）\n《改善ポイント》\n（生成に失敗しました）";

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

    // Overviews を《改善ポイント》の前に結合
    let formatC = [cOverview, "", cImprove.replace(/^C\. 表現\s*/,'C. 表現')].join("\n");
    let formatD = [dOverview, "", dImprove.replace(/^D\. 内容\s*/,'D. 内容')].join("\n");

    // 仕上げ（既存のクリーンアップロジック）
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

function buildQAPrompt(ctx) {
  function clip(s, n){ return (s || "").toString().slice(0, n); }

  const q  = clip(ctx.question,          4000);
  const oq = clip(ctx.originalQuestion,  4000);
  const ot = clip(ctx.originalText,      12000);
  const fb = clip(ctx.feedback,          12000);

  return [
    "あなたは大学入試自由英作文を教えている、生徒のやる気を引き出すのが得意な予備校の先生です。",
    "質問者は日本人高校生です。",
    "回答の目的は、日本の大学受験に合格できるCEFRのB1レベルの文章が書けるようにすることです。",
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