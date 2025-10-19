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

/* =============== ユーティリティ =============== */

function clip(s, n){ return (s == null ? "" : String(s)).slice(0, n); }

function normalizeBlankLines(text) {
  if (!text) return text;
  return String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}(?=[ \t\u3000]*S\d+(?:→S\d+)?)/g, "\n\n")
    .replace(/(《改善ポイント》)\n{2,}/g, "$1\n");
}

/* =============== Gemini 呼び出し（堅牢版） =============== */

function extractModelText(body){
  const cand = body?.candidates?.[0];
  if (!cand) return { text: "", reason: "no_candidates" };

  let text = "";
  const parts = cand?.content?.parts;
  if (Array.isArray(parts)) {
    text = parts.map(p => p?.text).filter(Boolean).join("");
  }
  if (!text && typeof cand?.text === "string") {
    text = cand.text;
  }
  if (!text) {
    const raw = JSON.stringify(body);
    const m = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (m && m[1]) text = m[1];
  }
  const block = body?.promptFeedback?.blockReason || cand?.finishReason;
  if (!text) return { text: "", reason: block || "empty_text" };
  return { text, reason: "ok" };
}

async function callGenerativeLanguageAPI(promptText, modelName, maxTokens = 512) {
  if (!GEMINI_API_KEY) {
    return "エラー: APIキーが未設定です。サーバーの .env で GEMINI_API_KEY を設定してください。";
  }
  const primary = modelName || 'gemini-2.5-flash';
  const models = [primary, 'gemini-2.0-flash-lite']; // フォールバック候補

  // ✅ 正式カテゴリ名に修正済み
  const safetySettings = [
    { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_ONLY_HIGH" },
    { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_ONLY_HIGH" },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
    // { category: "HARM_CATEGORY_CIVIC_INTEGRITY",   threshold: "BLOCK_ONLY_HIGH" }, // 必要時のみ
  ];

  for (const effectiveModel of models) {
    const ENDPOINT =
      `https://generativelanguage.googleapis.com/v1beta/models/${effectiveModel}:generateContent?key=${GEMINI_API_KEY}`;

    const payload = {
      contents: [{ parts: [{ text: promptText }]}],
      generationConfig: {
        candidateCount: 1,
        temperature: 0.2,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: maxTokens
      },
      safetySettings
    };

    for (let i = 0; i < 3; i++) {
      try {
        const res = await axios.post(ENDPOINT, payload, {
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          validateStatus: () => true,
          timeout: 30000
        });
        const code = res.status;
        const body = res.data;

        if (code === 200) {
          const { text, reason } = extractModelText(body);
          if (text) return text;

          const br = body?.promptFeedback?.blockReason;
          const sr = body?.candidates?.[0]?.safetyRatings;
          const meta = `blockReason=${br || reason || "unknown"} safety=${JSON.stringify(sr || [])}`;
          if (i === 2) return `エラー: モデル応答が安全ポリシーでブロック/空でした（${meta}）。`;
          await new Promise(r => setTimeout(r, 800 * (i + 1)));
          continue;
        }

        if (code === 503) { await new Promise(r => setTimeout(r, 2000 * (i + 1))); continue; }
        if (code === 429) return "エラー: リクエスト過多です。しばらくしてから再実行してください。";
        if (code === 401 || code === 403) return "エラー: 認証/権限に問題があります。APIキーや割り当てをご確認ください。";
        if (code === 404) return "エラー: モデルIDが認識されません。指定モデルをご確認ください。";
        if (code >= 500) return "エラー: サーバー側で問題が発生しました。時間を置いて再実行してください。";

        return `エラー: サービス応答に問題（HTTP ${code}）。body=${JSON.stringify(body).slice(0,800)}`;
      } catch (e) {
        if (i === 2) return "エラー: 例外が発生しました → " + e;
        await new Promise(r => setTimeout(r, 800 * (i + 1)));
      }
    }
  }

  return "エラー: すべてのモデルで応答が得られませんでした。";
}

/* =============== 評価プロンプト（JSON出力） =============== */

function buildExpressionPrompt(opts) {
  const question = clip((opts && opts.question) || "", 2000);
  const answerNumbered = clip((opts && opts.answerNumbered) || "", 6000);
  const mode = (opts && opts.mode) || "json";

  if (mode === "json") {
    const sys = [
      "あなたは大学入試の厳密な採点官です。",
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

  throw new Error("buildExpressionPrompt: invalid mode");
}

function buildContentPrompt(opts) {
  const question = clip((opts && opts.question) || "", 2000);
  const answerNumbered = clip((opts && opts.answerNumbered) || "", 6000);
  const mode = (opts && opts.mode) || "json";

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

  throw new Error("buildContentPrompt: invalid mode");
}

/* =============== 改善配列 JSON プロンプト =============== */

function buildExpressionImprovementsJSONPrompt({ question, answerNumbered, expObj }) {
  const q  = clip(question, 2000);
  const an = clip(answerNumbered, 6000);
  const ej = clip(JSON.stringify(expObj || {}), 2500);

  return [
    "あなたは大学入試の厳密な採点官です。",
    "対象は日本人高校生。CEFR B1を目標とします。",
    "以下は表現評価の機械可読結果です。この評価を変更せず、必要な改善点のみを抽出してください。",
    "",
    "【問題文】", q || "（問題文なし）",
    "",
    "【あなたの答案（文番号付き）】", an,
    "",
    "【評価結果（固定）】", ej,
    "",
    "出力は JSON のみ。次のスキーマに**厳密**に従ってください：",
    "{",
    '  "type": "expression_improvements",',
    '  "items": [',
    '    {',
    '      "s": "S番号（例：S3 あるいは S3→S4）",',
    '      "cat": "①文法・語法 | ②語彙・文構造 のいずれか",',
    '      "error": "簡潔なエラーメッセージ（日本語）",',
    '      "before": "原文の該当箇所（必要なら短く）",',
    '      "after": "修正例（過剰な意味改変を避ける）",',
    '      "reason": "修正例の後に付記する修正理由（必須・20〜40字、学習者目線）"',
    '    }',
    '  ]',
    "}",
    "",
    "制約：",
    "- itemsは最大6件まで。重要度の高い順に。",
    "- reasonは**空文字禁止**。具体で簡潔（20〜40字）。",
    "- 文法・語法/語彙・文構造の範囲外（内容・論理）は含めない。"
  ].join("\n");
}

function buildContentImprovementsJSONPrompt({ question, answerNumbered, contObj }) {
  const q  = clip(question, 2000);
  const an = clip(answerNumbered, 6000);
  const cj = clip(JSON.stringify(contObj || {}), 2500);

  return [
    "あなたは大学入試自由英作文の指導者です。対象は日本人高校生。CEFR B1を目標とします。",
    "以下は内容評価（主題/論理）の機械可読結果です。この評価を変更せず、必要な改善点のみを抽出してください。",
    "",
    "【問題文】", q || "（問題文なし）",
    "",
    "【あなたの答案（文番号付き）】", an,
    "",
    "【評価結果（固定）】", cj,
    "",
    "出力は JSON のみ。次のスキーマに**厳密**に従ってください：",
    "{",
    '  "type": "content_improvements",',
    '  "items": [',
    '    {',
    '      "s": "S番号（例：S3→S4 などの飛躍も可）",',
    '      "cat": "1主題の一貫性 | 2論理展開 のいずれか",',
    '      "error": "簡潔な問題点（日本語）",',
    '      "before": "原文の該当箇所（必要なら短く）",',
    '      "after": "修正例（過剰な意味改変を避ける）",',
    '      "reason": "修正例の後に付記する修正理由（必須・20〜40字、学習者目線）"',
    '    }',
    '  ]',
    "}",
    "",
    "制約：",
    "- itemsは最大6件まで。重要度の高い順に。",
    "- reasonは**空文字禁止**。具体で簡潔（20〜40字）。",
    "- 文法/語法・語彙・文構造は含めない。"
  ].join("\n");
}

/* =============== JSONパース/補修/整形 =============== */

function safeParseModelJSON(text, label="") {
  if (!text) throw new Error(`モデル応答が空です（${label}）。`);
  if (/^エラー|^APIからの有効な応答がありませんでした。/.test(text)) {
    throw new Error(`モデル応答がエラーです（${label}）: ` + text);
  }
  const m = text.match(/\{[\s\S]*\}/);
  const jsonStr = m ? m[0] : text.trim();
  const obj = JSON.parse(jsonStr);
  if (!obj || !obj.items) throw new Error(`JSON形式が不正です（${label}）。`);
  return obj;
}

function safeParseImprovementsJSON(text, label="") {
  if (!text) throw new Error(`モデル応答が空です（${label}）。`);
  const m = text.match(/\{[\s\S]*\}/);
  const jsonStr = m ? m[0] : text.trim();
  const obj = JSON.parse(jsonStr);
  if (!obj || !Array.isArray(obj.items)) throw new Error(`改善JSONの形式が不正です（${label}）。`);
  return obj;
}

function ensureReasons(items) {
  return items.map(it => {
    let reason = String(it.reason || "").trim();
    if (!reason) {
      if ((it.cat || "").includes("文法")) reason = "文法規則に合わせて誤用を正し、読み手の誤解を防ぐため。";
      else if ((it.cat || "").includes("語彙")) reason = "表現をB1相当へ整え、意味の明確さと読みやすさを高めるため。";
      else if ((it.cat || "").includes("主題")) reason = "主題から逸れないよう内容を焦点化し、一貫性を保つため。";
      else reason = "論理のつながりを明示し、主張を理解しやすくするため。";
    }
    return { ...it, reason: clip(reason, 50) }; // 20〜40字目安、上限50
  });
}

function renderExpressionDetailFromImps({ expObj, imps }) {
  const items = ensureReasons(imps || []);
  const lines = [];
  lines.push("C. 表現");
  lines.push("《項目ごとのフィードバック》");
  const c1 = expObj?.items?.["C-1"] || "o";
  const c2 = expObj?.items?.["C-2"] || "o";
  const c1mark = c1 === "x" ? "×" : c1 === "d" ? "△" : "〇";
  const c2mark = c2 === "x" ? "×" : c2 === "d" ? "△" : "〇";
  lines.push(`①文法・語法 → ${c1mark}`);
  lines.push(`②語彙・文構造 → ${c2mark}`);
  lines.push("《改善ポイント》");
  if (items.length === 0) lines.push("（特になし）");
  for (const it of items) {
    lines.push(`${it.s}　${it.cat}`);
    if (it.before) lines.push(it.before);
    if (it.after)  lines.push(`→ ${it.after}`);
    lines.push(`修正理由：${it.reason}`);
  }
  return lines.join("\n");
}

function renderContentDetailFromImps({ contObj, imps }) {
  const items = ensureReasons(imps || []);
  const lines = [];
  lines.push("D. 内容");
  lines.push("《項目ごとのフィードバック》");
  const d1 = contObj?.items?.["D-1"] || "o";
  const d2 = contObj?.items?.["D-2"] || "o";
  const leaps = Number(contObj?.details?.["D-2_leaps"] ?? 0);
  const d1mark = d1 === "x" ? "×" : d1 === "d" ? "△" : "〇";
  const d2mark = d2 === "x" ? "×" : d2 === "d" ? "△" : "〇";
  const tail = (d2 !== "o" && leaps > 0) ? `（飛躍${leaps}件）` : "";
  lines.push(`①主題が一貫している → ${d1mark}`);
  lines.push(`②本文が論理的に展開されている → ${d2mark}${tail}`);
  lines.push("《改善ポイント》");
  if (items.length === 0) lines.push("（特になし）");
  for (const it of items) {
    lines.push(`${it.s}　${it.cat}`);
    if (it.before) lines.push(it.before);
    if (it.after)  lines.push(`→ ${it.after}`);
    lines.push(`修正理由：${it.reason}`);
  }
  return lines.join("\n");
}

/* =============== スコア/整形ガード =============== */

function computeScoresByThresholds(expObj, contObj) {
  let exp = 10;
  let incorrect = 0;
  if (expObj?.details && typeof expObj.details["C-1_incorrect"] !== "undefined") {
    incorrect = Number(expObj.details["C-1_incorrect"]) || 0;
  }
  exp -= Math.min(Math.max(incorrect, 0), 8);

  const v11 = expObj?.items ? expObj.items["C-1"] : undefined;
  if (v11 === 'd' && incorrect === 0) exp -= 2;

  const v12 = expObj?.items ? expObj.items["C-2"] : undefined;
  if (v12 === 'd') exp -= 2;
  else if (v12 === 'x') exp -= 4;

  exp = Math.round(Math.min(10, Math.max(2, exp)));

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

/* =============== 採点要件・QA プロンプト =============== */

function buildRequirementJudgementPrompt(question, wordCount) {
  const q = clip(question || "（問題文なし）", 2000);
  return [
    "あなたは大学入試の厳密な採点官です。",
    "次の情報を踏まえ、「採点要件：」で始まる1行の日本語だけを出力してください。",
    "・問題文：" + q,
    "・語数：" + String(wordCount) + "語",
    "要件：問題文の条件（語数・指定事項）を満たしているかを簡潔に判定（20～40字程度）。",
    "出力例：採点要件： あなたの答案は58語で問題文に指示された条件をすべて満たしていません。"
  ].join("\n");
}

function buildQAPrompt(ctx) {
  const q  = clip(ctx.question,          4000);
  const oq = clip(ctx.originalQuestion,  4000);
  const ot = clip(ctx.originalText,     12000);
  const fb = clip(ctx.feedback,         12000);

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

/* =============== フィードバックAPI本体 =============== */

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

    // JSON評価（短出力）を並列化
    const [expJsonText, contJsonText] = await Promise.all([
      callGenerativeLanguageAPI(
        buildExpressionPrompt({ question, answerNumbered: studentTextNumbered, mode: 'json' }),
        modelId,
        600
      ),
      callGenerativeLanguageAPI(
        buildContentPrompt({ question, answerNumbered: studentTextNumbered, mode: 'json' }),
        modelId,
        600
      )
    ]);

    const expObj  = safeParseModelJSON(expJsonText, "表現JSON");
    const contObj = safeParseModelJSON(contJsonText, "内容JSON");

    // スコア計算
    const { expScore, contScore, totalScore } = computeScoresByThresholds(expObj, contObj);

    // 改善配列JSON（理由必須）を並列化
    const [expImpText, contImpText, requirementLineRaw] = await Promise.all([
      callGenerativeLanguageAPI(
        buildExpressionImprovementsJSONPrompt({ question, answerNumbered: studentTextNumbered, expObj }),
        modelId,
        700
      ),
      callGenerativeLanguageAPI(
        buildContentImprovementsJSONPrompt({ question, answerNumbered: studentTextNumbered, contObj }),
        modelId,
        700
      ),
      callGenerativeLanguageAPI(
        buildRequirementJudgementPrompt(question, wordCount),
        modelId,
        80
      )
    ]);

    const expImps = safeParseImprovementsJSON(expImpText, "表現改善JSON").items;
    const contImps = safeParseImprovementsJSON(contImpText, "内容改善JSON").items;

    // 整形（必ず「修正例→修正理由」を出力）
    let safeC = renderExpressionDetailFromImps({ expObj, imps: expImps });
    safeC = normalizeBlankLines(enforceExpressionDetailScope(safeC));

    let safeD = renderContentDetailFromImps({ contObj, imps: contImps });
    safeD = normalizeBlankLines(enforceContentDetailConsistency(contObj, safeD));

    // 採点要件の1行
    let requirementLine = (requirementLineRaw || "").split("\n")[0];

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

    const feedbackAll = [
      sectionA,
      "", sectionB,
      "", sanitizeDetail(safeC, "C. 表現"),
      "", sanitizeDetail(safeD, "D. 内容")
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

    const prompt = buildQAPrompt({ question, originalQuestion, originalText, feedback });
    const answer = await callGenerativeLanguageAPI(prompt, modelId, 700);

    if (!answer || answer.startsWith("エラー") || answer.startsWith("APIからの有効な応答がありませんでした。")) {
      return { status: 'error', message: answer || '応答の解析に失敗しました。' };
    }
    return { status: 'success', answer };
  } catch (err) {
    return { status: 'error', message: String(err) };
  }
}

/* =============== API ルート =============== */

app.post('/api/feedback', async (req, res) => {
  const result = await getFeedback(req.body || {});
  res.json(result);
});

app.post('/api/qa', async (req, res) => {
  const result = await getQA(req.body || {});
  res.json(result);
});

/* =============== 起動 =============== */
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`Sakubun-kun FW running: http://localhost:${PORT}`);
});
